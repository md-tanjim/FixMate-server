// import dns from 'node:dns';
// dns.setServers(['8.8.8.8', '1.1.1.1']);

import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import Stripe from 'stripe';


// Stripe setup
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is missing from the backend .env file.");
}

const stripe = new Stripe(stripeSecretKey);

const app = express();
const PORT = 5000;



//-----------------------------Stripe webhook--------------------------------//

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];

    // 1. Check webhook secret
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.error("STRIPE_WEBHOOK_SECRET is missing.");

        return res.status(500).send({
            message: "Webhook secret is not configured.",
        });
    }

    // 2. Check Stripe signature
    if (typeof signature !== "string") {
        return res.status(400).send({
            message: "Missing Stripe signature.",
        });
    }

    // 3. Verify that the request genuinely came from Stripe

    //     console.log("Is raw body Buffer?", Buffer.isBuffer(req.body));
    // console.log("Content-Type:", req.headers["content-type"]);
    // console.log(
    //   "Webhook secret configured:",
    //   Boolean(process.env.STRIPE_WEBHOOK_SECRET)
    // );


    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        console.error("Stripe signature verification failed:", error.message);

        return res.status(400).send({
            message: `Webhook Error: ${error.message}`,
        });
    }

    try {
        // 4. Handle successful one-time Checkout payments
        switch (event.type) {
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded": {
                const session = event.data.object;

                // Make sure this is a one-time payment.
                if (session.mode !== "payment") {
                    console.log("Ignoring non-payment Checkout Session:", session.id);
                    break;
                }

                // Only process successfully paid sessions.
                if (session.payment_status !== "paid") {
                    console.log("Payment is not completed yet:", session.id);
                    break;
                }

                // 5. Get booking information from Checkout metadata.
                const bookingId = session.metadata?.bookingId;
                const metadataEmail = session.metadata?.customerEmail
                    ?.trim()
                    .toLowerCase();

                if (
                    !bookingId ||
                    !ObjectId.isValid(bookingId) ||
                    !metadataEmail
                ) {
                    console.error("Invalid booking metadata:", session.metadata);

                    return res.status(400).send({
                        message: "Invalid Checkout Session metadata.",
                    });
                }

                // 6. Get the Stripe PaymentIntent ID.
                const transactionId =
                    typeof session.payment_intent === "string"
                        ? session.payment_intent
                        : session.payment_intent?.id;

                if (!transactionId) {
                    throw new Error(
                        `PaymentIntent missing from Checkout Session ${session.id}`
                    );
                }

                // 7. Find the booking.
                const bookingObjectId = new ObjectId(bookingId);

                const booking = await bookingsCollection.findOne({
                    _id: bookingObjectId,
                });

                if (!booking) {
                    console.error("Booking not found:", bookingId);

                    return res.status(404).send({
                        message: "Booking not found.",
                    });
                }

                // 8. Verify that the Checkout Session belongs to this booking's customer.
                if (
                    booking.customerEmail?.trim().toLowerCase() !== metadataEmail
                ) {
                    console.error("Customer email mismatch:", bookingId);

                    return res.status(400).send({
                        message: "Customer verification failed.",
                    });
                }

                // 9. Verify the booking is completed.
                if (booking.status !== "completed") {
                    console.error("Booking is not completed:", bookingId);

                    return res.status(400).send({
                        message: "This booking is not completed.",
                    });
                }

                // 10. Verify the amount and currency against MongoDB.
                const expectedAmount = Math.round(
                    Number(booking.finalAmount) * 100
                );

                if (
                    !Number.isSafeInteger(expectedAmount) ||
                    session.amount_total !== expectedAmount ||
                    session.currency !== "usd"
                ) {
                    console.error("Payment amount or currency mismatch:", {
                        bookingId,
                        expectedAmount,
                        stripeAmount: session.amount_total,
                        stripeCurrency: session.currency,
                    });

                    return res.status(400).send({
                        message: "Payment amount verification failed.",
                    });
                }

                // 11. Check whether this booking already has a payment record.
                const existingPayment = await paymentsCollection.findOne({
                    bookingId: bookingId,
                });

                if (existingPayment) {
                    // Same Checkout Session: this is a repeated webhook delivery.
                    if (existingPayment.stripeSessionId === session.id) {
                        console.log(
                            "Payment already recorded. Duplicate webhook:",
                            session.id
                        );

                        // Ensure the booking is marked as paid.
                        await bookingsCollection.updateOne(
                            {
                                _id: bookingObjectId,
                                status: "completed",
                                paymentStatus: "unpaid",
                            },
                            {
                                $set: {
                                    paymentStatus: "paid",
                                },
                            }
                        );

                        break;
                    }

                    // A different Checkout Session has already paid this booking.
                    console.error(
                        "A payment already exists for this booking with another Stripe session:",
                        bookingId
                    );

                    // Do not insert a second payment document.
                    break;
                }

                // 12. Create the payment document using your exact PDF schema.
                const paymentData = {
                    bookingId: bookingId,

                    serviceTitle: booking.serviceTitle,

                    customerName: booking.customerName,
                    customerEmail: booking.customerEmail,

                    technicianName: booking.technicianName,
                    technicianEmail: booking.technicianEmail,

                    amount: Number(booking.finalAmount),
                    currency: "usd",

                    transactionId: transactionId,
                    stripeSessionId: session.id,

                    paymentStatus: "paid",

                    paidAt: new Date(event.created * 1000),
                };

                // 13. Insert payment record.
                try {
                    await paymentsCollection.insertOne(paymentData);
                } catch (error) {
                    // Handle concurrent or repeated webhook deliveries.
                    if (error.code !== 11000) {
                        throw error;
                    }

                    console.log(
                        "Duplicate payment insertion prevented:",
                        bookingId
                    );

                    const existing = await paymentsCollection.findOne({
                        bookingId: bookingId,
                    });

                    if (!existing || existing.stripeSessionId !== session.id) {
                        break;
                    }
                }

                // 14. Update booking payment status.
                const updateResult = await bookingsCollection.updateOne(
                    {
                        _id: bookingObjectId,
                        status: "completed",
                        paymentStatus: "unpaid",
                    },
                    {
                        $set: {
                            paymentStatus: "paid",
                        },
                    }
                );

                if (updateResult.modifiedCount === 0) {
                    // The booking might already have been updated by a
                    // repeated webhook or another successful request.
                    const updatedBooking = await bookingsCollection.findOne({
                        _id: bookingObjectId,
                    });

                    if (updatedBooking?.paymentStatus !== "paid") {
                        throw new Error(
                            `Payment was recorded but booking ${bookingId} could not be marked as paid.`
                        );
                    }
                }

                console.log(
                    "FixMate payment successfully recorded:",
                    session.id
                );

                break;
            }

            default:
                console.log("Unhandled Stripe event:", event.type);
                break;
        }

        // 15. Acknowledge the event.
        return res.status(200).send({
            received: true,
        });
    } catch (error) {
        console.error("FixMate Stripe webhook processing error:", error);

        // A 500 response tells Stripe that the event needs retrying.
        return res.status(500).send({
            received: false,
            message: "Webhook processing failed.",
        });
    }
}
);

//---------------------^^^--------Stripe webhook----------^^^----------------------//





//---------------------------------All MiddleWire-------------------------------------------------------//




app.use(cors());
app.use(express.json());

//JWT
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({
            message: "Unauthorized. Token is missing.",
        });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).send({
            message: "Unauthorized. Token is missing.",
        });
    }

    const JWKS = createRemoteJWKSet(
        new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
    );

    try {
        const { payload } = await jwtVerify(token, JWKS);


        req.user = payload;

        console.log("Verified JWT payload:", req.user);

        next();
    } catch (error) {
        console.error("JWT verification error:", error);

        return res.status(401).send({
            message: "Invalid or expired token.",
        });
    }
};


const verifyCustomer = (req, res, next) => {
    console.log(req.user.role, "is roleeeeeeeeeee hhhhhhhhhhhhhhhhhhhhhheeeeeeeeeeeeerrrrrrrrrrrrrreeeeeeeeeee")
    if (req.user?.role !== "customer") {
        return res.status(403).send({
            message: "Access denied. Customers only.",
        });
    }

    next();
};

const verifyTechnician = (req, res, next) => {
    if (req.user?.role !== "technician") {
        return res.status(403).send({
            message: "Access denied. Technicians only.",
        });
    }

    next();
};


const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({
      success: false,
      message: "Forbidden. Admin access required.",
    });
  }

  next();
};


//----------------------^^^-----------All MiddleWire---------------^^^----------------------------------------//



app.get('/', (req, res) => {
    res.send("server is running gooood");
})


const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ojmgvh3.mongodb.net/`);

//  console.log('client====================', client);

export async function connecToMongodb() {
    try {
        await client.connect();
        console.log('successfully connected too mongodb');
        return client;

    } catch (error) {
        console.error('MongoDB connection failed:', error);
        throw error; // Prevents returning undefined
    }
}


//Mnogodb Database(hireloopdb) and collection(jobs)  connection
const connectedClient = await connecToMongodb();
const db = connectedClient.db('assignment-9');
const usersCollection = db.collection('user');
const paymentsCollection = db.collection('payments');
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");




//------------------------indexes---------------------------------//

// One payment per booking.
await paymentsCollection.createIndex(
    { bookingId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            bookingId: { $type: "string" },
        },
        name: "unique_payment_per_booking",
    }
);

// Every Stripe Checkout Session must be unique.
await paymentsCollection.createIndex(
    { stripeSessionId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            stripeSessionId: { $type: "string" },
        },
        name: "unique_stripe_session",
    }
);

// Retrieve a customer's payment history efficiently.
await paymentsCollection.createIndex(
    { customerEmail: 1, paidAt: -1 },
    {
        name: "customer_payment_history",
    }
);


//-----------------^^^-------indexes-----^^^----------------------------//







//---------------------------------ALL Stripe, Payment Ures Related APIs--------------------------//



// Create Stripe Checkout Session for a completed booking
app.post("/api/payments/create-checkout-session", verifyToken, verifyCustomer, async (req, res) => {
    try {
        const { bookingId } = req.body;


        // 2. Identify authenticated customer
        const customerEmail = req.user?.email;

        if (!customerEmail) {
            return res.status(401).send({
                message: "Unable to identify the customer.",
            });
        }

        // 3. Find the customer's booking
        const booking = await bookingsCollection.findOne({
            _id: new ObjectId(bookingId),
            customerEmail,
        });

        if (!booking) {
            return res.status(404).send({
                message: "Booking not found.",
            });
        }

        // 4. Verify booking status
        if (booking.status !== "completed") {
            return res.status(400).send({
                message: "Payment is only available for completed bookings.",
            });
        }

        // 5. Verify payment status
        if (booking.paymentStatus !== "unpaid") {
            return res.status(400).send({
                message: "This booking has already been paid.",
            });
        }

        // 6. Get final amount from MongoDB
        const finalAmount = Number(booking.finalAmount);

        if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
            return res.status(400).send({
                message: "Invalid booking payment amount.",
            });
        }

        const amountInCents = Math.round(finalAmount * 100);

        if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0) {
            return res.status(400).send({
                message: "Invalid payment amount.",
            });
        }



        // 7. Create Stripe Checkout Session
        const checkoutSession = await stripe.checkout.sessions.create({
            mode: "payment",

            customer_email: customerEmail,

            client_reference_id: booking._id.toString(),

            line_items: [
                {
                    price_data: {
                        currency: "usd",

                        product_data: {
                            name: booking.serviceTitle,
                            description: `Repair service provided by ${booking.technicianName}`,
                        },

                        unit_amount: amountInCents,
                    },

                    quantity: 1,
                },
            ],

            metadata: {
                bookingId: booking._id.toString(),
                customerEmail: booking.customerEmail,
            },

            success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

            cancel_url: `${process.env.CLIENT_URL}/payment/cancel?booking_id=${booking._id}`,
        });

        // 8. Return Checkout URL to frontend
        if (!checkoutSession.url) {
            return res.status(500).send({
                message: "Unable to generate Stripe Checkout URL.",
            });
        }

        return res.status(201).send({
            message: "Checkout session created successfully.",
            url: checkoutSession.url,
            sessionId: checkoutSession.id,
        });
    } catch (error) {
        console.error("Create checkout session error:", error);

        return res.status(500).send({
            message: "Something went wrong while creating the payment session.",
        });
    }
}
);


//---------------------------------ALL Stripe, Payment,Usres Related APIs--------------------------//














//---------------------------------All Customer API-----------------------------//


app.get('/customer/bookings/dashboard/:email', verifyToken, verifyCustomer, async (req, res) => {
    const { email } = req.params;

    const results = await bookingsCollection.find({ customerEmail: email }).sort({ createdAt: -1 }).limit(5).toArray();

    res.send(results);
});

app.get('/customer/bookings/:email/count-req-prog-comp', async (req, res) => {
    const { email } = req.params;

    const [requested, inProgress, completed] = await Promise.all([
        bookingsCollection.countDocuments({ customerEmail: email }),
        bookingsCollection.countDocuments({ customerEmail: email, status: "in-progress" }),
        bookingsCollection.countDocuments({ customerEmail: email, status: "completed" })
    ]);

    res.send({
        requested,
        inProgress,
        completed
    });
});


// Cancel a customer booking
app.patch("/customer/bookings/:id/cancel", verifyToken, verifyCustomer, async (req, res) => {
    try {
        const { id } = req.params;

        const bookingId = new ObjectId(id);



        const result = await bookingsCollection.updateOne(
            { _id: bookingId, status: "requested" },
            {
                $set: {
                    status: "cancelled",
                },
            }
        );

        if (result.modifiedCount === 0) {
            return res.status(409).send({
                message:
                    "This booking has already been updated and can no longer be cancelled.",
            });
        }

        return res.status(200).send({
            message: "Booking cancelled successfully.",
            bookingId: id,
            status: "cancelled",
        });
    } catch (error) {
        console.error("Cancel booking error:", error);

        return res.status(500).send({
            message: "Something went wrong while cancelling the booking.",
        });
    }
}
);


// Get all bookings belonging to a specific customer
app.get("/customer/all-bookings/:email", verifyToken, verifyCustomer, async (req, res) => {

    try {

        const { email } = req.params;

        if (!email) {
            return res.status(401).send({
                message: "Unauthorized.",
            });
        }


        const bookings = await bookingsCollection
            .find({
                customerEmail: email,
            })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).send(bookings);
    } catch (error) {
        console.error("Get customer bookings error:", error);

        return res.status(500).send({
            message: "Something went wrong while fetching bookings.",
        });
    }
}
);


// Get payment history for the logged-in customer
app.get("/customer/payments", verifyToken, verifyCustomer, async (req, res) => {
    try {
        const customerEmail = req.user?.email

        if (!customerEmail) {
            return res.status(401).json({
                message: "Customer information is missing from the token.",
            });
        }

        const payments = await paymentsCollection.find({ customerEmail, paymentStatus: "paid", }).sort({ paidAt: -1 }).toArray();

        return res.status(200).json({ payments });
    } catch (error) {
        console.error("Error fetching customer payments:", error);

        return res.status(500).json({
            message: "Failed to fetch payment history.",
        });
    }
}
);



//service booking 
app.post("/customer/bookings",verifyToken,verifyCustomer,async (req, res) => {
    try {
      const {
        serviceId,
        customerPhone,
        address,
        preferredDate,
        problemDescription,
      } = req.body;

      //Validate customer input
      const phone = customerPhone?.trim();
      const serviceAddress = address?.trim();
      const description = problemDescription?.trim();

      if (!phone || !serviceAddress || !preferredDate || !description) {
        return res.status(400).send({
          success: false,
          message: "Please provide all required booking information.",
        });
      }

      if (description.length < 20) {
        return res.status(400).send({
          success: false,
          message: "Problem description must contain at least 20 characters.",
        });
      }

      
      // 3. Validate preferred date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
        return res.status(400).send({
          success: false,
          message: "Invalid preferred date.",
        });
      }

      const preferredDateObject = new Date(
        `${preferredDate}T00:00:00.000Z`
      );

      //real calendar date.
      if (
        Number.isNaN(preferredDateObject.getTime()) ||
        preferredDateObject.toISOString().slice(0, 10) !== preferredDate
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid preferred date.",
        });
      }

      // date validate
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Dhaka",
      }).format(new Date());

      if (preferredDate < today) {
        return res.status(400).send({
          success: false,
          message: "Preferred date cannot be in the past.",
        });
      }

      
      //Get authenticated customer information
      const customerEmail = req.user?.email;
      const customerName = req.user?.name;

      if (!customerEmail || !customerName) {
        return res.status(401).send({
          success: false,
          message: "Customer authentication information is missing.",
        });
      }

      
      //service from MongoDB
      const service = await servicesCollection.findOne({
        _id: new ObjectId(serviceId),
        approvalStatus: "approved",
        isAvailable: true,
      });

      if (!service) {
        return res.status(404).send({
          success: false,
          message: "This service is no longer available.",
        });
      }

      
      //prevent duplicate active requests
      const existingBooking = await bookingsCollection.findOne({
        serviceId: service._id.toString(),
        customerEmail,
        status: {
          $in: ["requested", "accepted", "in-progress"],
        },
      });

      if (existingBooking) {
        return res.status(409).send({
          success: false,
          message: "You already have an active request for this service.",
          code: "DUPLICATE_ACTIVE_REQUEST",
        });
      }

      
      //Prepare booking document
      const booking = {
        serviceId: service._id.toString(),

        // Copied from the service document.
        serviceTitle: service.title,
        serviceImage: service.image,
        category: service.category,
        basePrice: service.basePrice,
        technicianName: service.technicianName,
        technicianEmail: service.technicianEmail,
        customerName,
        customerEmail,

        customerPhone: phone,
        address: serviceAddress,
        preferredDate: preferredDateObject,
        problemDescription: description,

        status: "requested",
        finalAmount: service.basePrice,
        paymentStatus: "unpaid",
      };

      
      //insert booking
      const result = await bookingsCollection.insertOne(booking);

      return res.status(201).send({
        success: true,
        message: "Repair request submitted successfully.",
        bookingId: result.insertedId.toString(),
      });

    } catch (error) {
      console.error("Create booking error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to submit repair request.",
      });
    }
  }
);



//----------------------------^^-----All Customer API-------^^^----------------------//



//---------------------------------All Technician API----------------------------//

// Technician dashboard: latest 5 services
app.get("/technician/dashboard/services/:email", verifyToken, verifyTechnician, async (req, res) => {
    try {
        const technicianEmail = req.user?.email?.trim().toLowerCase();
        const requestedEmail = req.params.email?.trim().toLowerCase();

        if (!technicianEmail) {
            return res.status(401).send({
                message: "Technician information is missing.",
            });
        }

        if (requestedEmail !== technicianEmail) {
            return res.status(403).send({
                message: "you cannot access another technicians services.",
            });
        }

        const results = await servicesCollection.find({ technicianEmail }).sort({ createdAt: -1 }).limit(5).toArray();

        return res.status(200).send(results);
    } catch (error) {
        console.error("Error fetching technician services:", error);

        return res.status(500).send({
            message: "Failed to fetch technician services.",
        });
    }
}
);


// Technician dashboard: service counts
app.get("/technician/services/:email/count", verifyToken, verifyTechnician, async (req, res) => {
    try {
        const technicianEmail = req.user?.email?.trim().toLowerCase();
        const requestedEmail = req.params.email?.trim().toLowerCase();

        if (!technicianEmail) {
            return res.status(401).send({
                message: "Technician information is missing.",
            });
        }

        if (requestedEmail !== technicianEmail) {
            return res.status(403).send({
                message: "You cannot access another technician's statistics.",
            });
        }

        const [total, approved, pending] = await Promise.all([
            servicesCollection.countDocuments({ technicianEmail }),
            servicesCollection.countDocuments({ technicianEmail, approvalStatus: "approved", }),

            servicesCollection.countDocuments({technicianEmail,approvalStatus: "pending"}),
        ]);

        return res.status(200).send({total,approved,pending});
    } catch (error) {
        console.error("Error fetching technician service counts:", error);

        return res.status(500).send({
            message: "Failed to fetch technician service counts.",
        });
    }
}
);



// Create a new service (techni only)
app.post("/technician/services",verifyToken,verifyTechnician, async (req, res) => {
        try {
            const {
                title,
                category,
                description,
                image,
                basePrice,
                estimatedDuration,
                serviceMode,
                serviceArea,
                isAvailable,
            } = req.body ?? {};

            
            // 1. Get technician from JWT
            const technicianEmail = req.user?.email?.trim().toLowerCase();
            const technicianName = req.user?.name?.trim();

            if (!technicianEmail || !technicianName) {
                return res.status(401).send({
                    message: "Technician information is missing.",
                });
            }


            // 2. Validate required text fields
            const requiredFields = [
                title,
                category,
                description,
                image,
                estimatedDuration,
                serviceMode,
                serviceArea,
            ];

            if (
                requiredFields.some(
                    (value) =>
                        typeof value !== "string" || !value.trim()
                )
            ) {
                return res.status(400).send({
                    message: "Please provide all required service information.",
                });
            }

            // 3. Validate category
            const allowedCategories = [
                "Smartphone",
                "Laptop & PC",
                "AC",
                "Refrigerator",
                "TV",
                "Washing Machine",
                "Electrical",
                "others"
            ];

            if (!allowedCategories.includes(category)) {
                return res.status(400).send({
                    message: "Invalid service category.",
                });
            }

            // 4. Validate service mode
            const allowedServiceModes = [
                "Home Visit",
                "Shop Drop-off",
            ];

            if (!allowedServiceModes.includes(serviceMode)) {
                return res.status(400).send({
                    message: "Invalid service mode.",
                });
            }

            // 5. Validate base price
            const parsedBasePrice = Number(basePrice);
            if (
                !Number.isFinite(parsedBasePrice) ||
                parsedBasePrice <= 0
            ) {
                return res.status(400).send({
                    message: "Starting price must be greater than zero.",
                });
            }

            // 6. Validate uploaded image URL
            let imageUrl;
            try {
                imageUrl = new URL(image);
            } catch {
                return res.status(400).send({
                    message: "Please upload a valid service image.",
                });
            }

            if (
                imageUrl.protocol !== "https:" ||
                !(
                    imageUrl.hostname === "ibb.co" ||
                    imageUrl.hostname.endsWith(".ibb.co")
                )
            ) {
                return res.status(400).send({
                    message: "Please use an image hosted on ImgBB.",
                });
            }

            // 7. Validate availability
            if (
                typeof isAvailable !== "undefined" &&
                typeof isAvailable !== "boolean"
            ) {
                return res.status(400).send({
                    message: "Invalid availability value.",
                });
            }

            // 8. Prepare service document
            const serviceData = {
                title: title.trim(),
                category,
                description: description.trim(),
                image: imageUrl.toString(),
                basePrice: parsedBasePrice,
                estimatedDuration: estimatedDuration.trim(),
                serviceMode,
                serviceArea: serviceArea.trim(),

                //techni identity from jwt
                technicianName,
                technicianEmail,

                //admin approve
                approvalStatus: "pending",

                isAvailable: isAvailable ?? true,

                createdAt: new Date().toISOString(),
            };

            // 9. insert mongoDb
            const result = await servicesCollection.insertOne(serviceData);

            return res.status(201).send({
                success: true,
                message: "Service created and submitted for admin approval.",
                insertedId: result.insertedId,
            });

        } catch (error) {
            console.error("Error creating technician service:", error);

            return res.status(500).send({
                message: "Failed to create service. Please try again.",
            });
        }
    }
);



//get all services loggedin techni
app.get("/technician/my-services",verifyToken,verifyTechnician,async (req, res) => {
        try {
            const technicianEmail = req.user?.email;

            if (!technicianEmail) {
                return res.status(401).send({
                    message: "Technician information is missing.",
                });
            }

            const services = await servicesCollection.find({ technicianEmail }).sort({ createdAt: -1 }).toArray();

            return res.status(200).send(services);

        } catch (error) {
            console.error("Get technician services error:", error);

            return res.status(500).send({
                message: "Failed to fetch your services.",
            });
        }
    }
);


//update service availability
app.patch("/technician/services/:id/availability",verifyToken,verifyTechnician,async (req, res) => {
        try {
            const { id } = req.params;
            const { isAvailable } = req.body ?? {};
            const technicianEmail = req.user?.email;


            if (typeof isAvailable !== "boolean") {
                return res.status(400).send({
                    message: "Availability must be true or false.",
                });
            }

            if (!technicianEmail) {
                return res.status(401).send({
                    message: "Technician information is missing.",
                });
            }

            const filter = {
                _id: new ObjectId(id),
                technicianEmail,
            };

            const service = await servicesCollection.findOne(filter);

            if (!service) {
                return res.status(404).send({
                    message: "Service not found.",
                });
            }

            if (service.approvalStatus === "rejected") {
                return res.status(403).send({
                    message: "Rejected services cannot change availability.",
                });
            }

         
            const result = await servicesCollection.updateOne(
                {
                    ...filter,
                    approvalStatus: { $ne: "rejected" },
                },
                {
                    $set: { isAvailable },
                }
            );

            if (result.matchedCount === 0) {
                return res.status(403).send({
                    message: "This service can no longer change availability.",
                });
            }

            const updatedService = await servicesCollection.findOne(filter);

            return res.status(200).send({
                success: true,
                message: "Service availability updated successfully.",
                service: updatedService,
            });

        } catch (error) {
            console.error("Update availability error:", error);

            return res.status(500).send({
                message: "Failed to update service availability.",
            });
        }
    }
);


//update sevice
app.patch("/technician/services/update/:id",verifyToken,verifyTechnician,async (req, res) => {
        try {
            const { id } = req.params;
            const technicianEmail = req.user?.email;


            if (!technicianEmail) {
                return res.status(401).send({
                    message: "Technician information is missing.",
                });
            }

            const {
                title,
                category,
                description,
                image,
                basePrice,
                estimatedDuration,
                serviceMode,
                serviceArea,
            } = req.body ?? {};

            // validate fields
            const textFields = [
                title,
                category,
                description,
                image,
                estimatedDuration,
                serviceMode,
                serviceArea,
            ];

            if (
                textFields.some(
                    (value) =>
                        typeof value !== "string" || !value.trim()
                )
            ) {
                return res.status(400).send({
                    message: "Please provide all required service fields.",
                });
            }

            //validate category
            const allowedCategories = [
                "Smartphone",
                "Laptop & PC",
                "AC",
                "Refrigerator",
                "TV",
                "Washing Machine",
                "Electrical",
                "others",
            ];

            if (!allowedCategories.includes(category)) {
                return res.status(400).send({
                    message: "Invalid service category.",
                });
            }

            // validate service mode
            const allowedServiceModes = [
                "Home Visit",
                "Shop Drop-off",
            ];

            if (!allowedServiceModes.includes(serviceMode)) {
                return res.status(400).send({
                    message: "Invalid service mode.",
                });
            }

            //validate price
            const parsedPrice = Number(basePrice);

            if (
                !Number.isFinite(parsedPrice) ||
                parsedPrice <= 0
            ) {
                return res.status(400).send({
                    message: "Base price must be greater than zero.",
                });
            }

            //Validate image URL
            let imageUrl;

            try {
                imageUrl = new URL(image);
            } catch {
                return res.status(400).send({
                    message: "Please provide a valid service image URL.",
                });
            }

            if (imageUrl.protocol !== "https:" && imageUrl.protocol !== "http:") {
                return res.status(400).send({
                    message: "Invalid image URL.",
                });
            }


            // Verify service ownership
            const filter = {_id: new ObjectId(id),technicianEmail};

            const existingService = await servicesCollection.findOne(filter);

            if (!existingService) {
                return res.status(404).send({
                    message: "Service not found.",
                });
            }

            // Updated service
            const updateData = {
                title: title.trim(),
                category,
                description: description.trim(),
                image: imageUrl.toString(),
                basePrice: parsedPrice,
                estimatedDuration: estimatedDuration.trim(),
                serviceMode,
                serviceArea: serviceArea.trim(),
                approvalStatus: "pending",
            };

            const result = await servicesCollection.updateOne(filter,{ $set: updateData });

            if (result.matchedCount === 0) {
                return res.status(404).send({
                    message: "Service not found.",
                });
            }

            const updatedService = await servicesCollection.findOne(filter);

            return res.status(200).send({
                success: true,
                message: "Service updated and submitted for re-approval.",
                service: updatedService,
            });

        } catch (error) {
            console.error("Update technician service error:", error);

            return res.status(500).send({
                message: "Failed to update service.",
            });
        }
    }
);


//delete servise
app.delete("/technician/services/:id",verifyToken,verifyTechnician,async (req, res) => {
        try {
            const { id } = req.params;
            const technicianEmail = req.user?.email;


            if (!technicianEmail) {
                return res.status(401).send({
                    message: "Technician information is missing.",
                });
            }

            const result = await servicesCollection.deleteOne({
                _id: new ObjectId(id),
                technicianEmail,
            });

            if (result.deletedCount === 0) {
                return res.status(404).send({
                    message: "Service not found.",
                });
            }

            return res.status(200).send({
                success: true,
                message: "Service deleted successfully.",
            });

        } catch (error) {
            console.error("Delete technician service error:", error);

            return res.status(500).send({
                message: "Failed to delete service.",
            });
        }
    }
);



//get all services for manage-request page
app.get("/technician/requests",verifyToken,verifyTechnician,async (req, res) => {
    try {
      const technicianEmail = req.user?.email;

      if (!technicianEmail) {
        return res.status(401).send({
          success: false,
          message: "Technician authentication information is missing.",
        });
      }

      const requests = await bookingsCollection
        .find({ technicianEmail })
        .sort({ preferredDate: 1 })
        .toArray();

      return res.send({
        success: true,
        requests,
      });
    } catch (error) {
      console.error("Get technician requests error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to load repair requests.",
      });
    }
  }
);


// --------------------------------------------------
// UPDATE TECHNICIAN REQUEST STATUS
// PATCH /technician/requests/:id/status
// --------------------------------------------------

app.patch(
  "/technician/requests/:id/status",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const technicianEmail = req.user?.email;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid booking ID.",
        });
      }

      if (!technicianEmail) {
        return res.status(401).send({
          success: false,
          message: "Technician authentication information is missing.",
        });
      }

      // Only these transitions are permitted.
      const allowedTransitions = {
        accepted: "requested",
        rejected: "requested",
        "in-progress": "accepted",
      };

      const expectedStatus = allowedTransitions[status];

      if (!expectedStatus) {
        return res.status(400).send({
          success: false,
          message: "Invalid booking status transition.",
        });
      }

      // Atomic conditional update:
      // The current status must match the expected previous status.
      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          technicianEmail,
          status: expectedStatus,
        },
        {
          $set: { status },
        }
      );

      if (result.matchedCount === 0) {
        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(id),
          technicianEmail,
        });

        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Repair request not found.",
          });
        }

        return res.status(409).send({
          success: false,
          message: `This request cannot move from ${booking.status} to ${status}.`,
        });
      }

      return res.send({
        success: true,
        message: `Request status updated to ${status}.`,
      });
    } catch (error) {
      console.error("Update request status error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to update request status.",
      });
    }
  }
);



// --------------------------------------------------
// COMPLETE TECHNICIAN REQUEST
// PATCH /technician/requests/:id/complete
// --------------------------------------------------

app.patch(
  "/technician/requests/:id/complete",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { finalAmount } = req.body;

      const technicianEmail = req.user?.email;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid booking ID.",
        });
      }

      if (!technicianEmail) {
        return res.status(401).send({
          success: false,
          message: "Technician authentication information is missing.",
        });
      }

      if (
        typeof finalAmount !== "number" ||
        !Number.isFinite(finalAmount) ||
        finalAmount <= 0
      ) {
        return res.status(400).send({
          success: false,
          message: "Final amount must be a number greater than zero.",
        });
      }

      // Only an in-progress job can be completed.
      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          technicianEmail,
          status: "in-progress",
        },
        {
          $set: {
            finalAmount,
            status: "completed",
          },
        }
      );

      if (result.matchedCount === 0) {
        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(id),
          technicianEmail,
        });

        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Repair request not found.",
          });
        }

        return res.status(409).send({
          success: false,
          message: "Only an in-progress repair can be completed.",
        });
      }

      return res.send({
        success: true,
        message: "Repair completed successfully. Waiting for payment.",
        finalAmount,
      });
    } catch (error) {
      console.error("Complete repair error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to complete repair.",
      });
    }
  }
);



//----------------------------^^-----All Technician API-------^^^----------------------//






//-------------------------All service(public) apis------------------------------//


//api for featured secition
app.get("/services/featured", async (req, res) => {
  try {
    const featuredServices = await servicesCollection.find({
        approvalStatus: "approved",
        isAvailable: true,
      }).sort({ createdAt: -1 }).limit(6).toArray();

    return res.status(200).send(featuredServices);
  } catch (error) {
    console.error("Featured services error:", error);

    return res.status(500).send({
      message: "Unable to fetch featured services.",
    });
  }
});



//get service details (public)
app.get("/services/:id", async (req, res) => {
    try {
        const { id } = req.params;
        // Validate MongoDB ObjectId.
        if (!ObjectId.isValid(id)) {
            return res.status(404).send({
                message: "Service not found.",
            });
        }
        //approved and available
        const service = await servicesCollection.findOne({
            _id: new ObjectId(id),
            approvalStatus: "approved",
            isAvailable: true,
        });

        if (!service) {
            return res.status(404).send({
                message: "Service not found.",
            });
        }

        const technicianProfile = await usersCollection.findOne(
            { email: service.technicianEmail },
            {
                projection: {
                    _id: 0,
                    name: 1,
                    image: 1,
                    area: 1,
                    bio: 1,
                },
            }
        );

        const technician = {
            name: technicianProfile?.name || service.technicianName,
            image: technicianProfile?.image || "",
            area: technicianProfile?.area || "",
            bio:
                typeof technicianProfile?.bio === "string"
                    ? technicianProfile.bio.trim()
                    : "",
        };

        return res.status(200).send({
            service,
            technician,
        });

    } catch (error) {
        console.error("Get service details error:", error);

        return res.status(500).send({
            message: "Failed to fetch service details.",
        });
    }
});




//for main service page
app.get("/services", async (req, res) => {
  try {
    const { search, category, serviceMode, sort } = req.query;

    //validate query parameters
    const allowedCategories = [
      "Smartphone",
      "Laptop & PC",
      "AC",
      "Refrigerator",
      "TV",
      "Washing Machine",
      "Electrical",
      "others",
    ];

    const allowedServiceModes = [
      "Home Visit",
      "Shop Drop-off",
    ];

    const allowedSortOptions = [
      "price-asc",
      "price-desc",
      "newest",
    ];


    if (
      (search !== undefined && typeof search !== "string") ||
      (category !== undefined && typeof category !== "string") ||
      (serviceMode !== undefined && typeof serviceMode !== "string") ||
      (sort !== undefined && typeof sort !== "string")
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid query parameters.",
      });
    }

    const searchText = search?.trim() || "";
    const selectedCategory = category?.trim() || "";
    const selectedServiceMode = serviceMode?.trim() || "";
    const selectedSort = sort?.trim() || "newest";

    if (searchText.length > 100) {
      return res.status(400).send({
        success: false,
        message: "Search text cannot exceed 100 characters.",
      });
    }

    if (
      selectedCategory &&
      !allowedCategories.includes(selectedCategory)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid service category.",
      });
    }

    if (
      selectedServiceMode &&
      !allowedServiceModes.includes(selectedServiceMode)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid service mode.",
      });
    }

    if (!allowedSortOptions.includes(selectedSort)) {
      return res.status(400).send({
        success: false,
        message: "Invalid sorting option.",
      });
    }


//============================mongoDB filter-------------=-=-==-==========

    const filter = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    //category filter
    if (selectedCategory) {
      filter.category = selectedCategory;
    }

    //service mode filter
    if (selectedServiceMode) {
      filter.serviceMode = selectedServiceMode;
    }

    //search by title OR category
    if (searchText) {
      // Escape special regex characters supplied by users.
      const escapedSearch = searchText.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      filter.$or = [
        {
          title: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
        {
          category: {
            $regex: escapedSearch,
            $options: "i",
          },
        },
      ];
    }

    //mongoDB sorting configuration
    const sortOptions = {
      "price-asc": {
        basePrice: 1,
        _id: 1,
      },

      "price-desc": {
        basePrice: -1,
        _id: -1,
      },

      newest: {
        createdAt: -1,
        _id: -1,
      },
    };

    //fetch services and total count
    const [services, total] = await Promise.all([
      servicesCollection
        .find(filter)
        .sort(sortOptions[selectedSort])
        .toArray(),

      servicesCollection.countDocuments(filter),
    ]);


    return res.status(200).send({
      success: true,
      total,
      services,
    });

  } catch (error) {
    console.error("Get public services error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to fetch services.",
    });
  }
});







//-------------^^^------------All service(public) apis--------^^^----------------------//











//----------------------------All ADIMIN APIs-----------------------------------------//


//for admin dashboard main overview
app.get("/admin/dashboard/overview",verifyToken,verifyAdmin,async (req, res) => {
    try {

        //range validate
      const range = req.query.range || "30d";

      const allowedRanges = ["all", "7d", "30d"];

      if (
        typeof range !== "string" ||
        !allowedRanges.includes(range)
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid dashboard date range.",
        });
      }

      const now = new Date();
      const DAY_IN_MS = 24 * 60 * 60 * 1000;

   
      //calcu time range
      let periodStart = null;
      let previousPeriodStart = null;

      const days =
        range === "7d" ? 7 : range === "30d" ? 30 : null;

      if (days !== null) {
        //include today and the 6 or 29 UTC days.
        const today = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate()
          )
        );

        periodStart = new Date(today);
        periodStart.setUTCDate(
          periodStart.getUTCDate() - (days - 1)
        );

        previousPeriodStart = new Date(periodStart);
        previousPeriodStart.setUTCDate(
          previousPeriodStart.getUTCDate() - days
        );
      }

      const dateFilter =
        range === "all"
          ? {}
          : {
              createdAt: {
                $gte: periodStart,
                $lte: now,
              },
            };

    
      //booking activity
      const bookingDateCondition = {
        $ne: null,
        $lte: now,
      };

      if (periodStart) {
        bookingDateCondition.$gte = periodStart;
      }

      const bookingDateFormat =
        range === "all" ? "%Y-%m" : "%Y-%m-%d";

      const bookingPipeline = [
        {
          $addFields: {
            activityDate: {
              $convert: {
                input: "$createdAt",
                to: "date",
                onError: null,
                onNull: null,
              },
            },
          },
        },
        {
          $match: {
            activityDate: bookingDateCondition,
          },
        },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  totalBookings: { $sum: 1 },
                  firstBookingDate: {
                    $min: "$activityDate",
                  },
                },
              },
            ],

            buckets: [
              {
                $group: {
                  _id: {
                    $dateToString: {  //need some more understandign
                      format: bookingDateFormat,
                      date: "$activityDate",
                      timezone: "UTC",
                    },
                  },
                  bookings: { $sum: 1 },
                },
              },
              {
                $sort: { _id: 1 },
              },
            ],
          },
        },
      ];


      //revenue aggregation
      const revenueDateFormat =
        range === "all" ? "%Y-%m" : "%Y-%m-%d";

      const currentPaymentStages =
        range === "all"
          ? []
          : [
              {
                $match: {
                  paymentDate: {
                    $gte: periodStart,
                    $lte: now,
                  },
                },
              },
            ];

      const previousPaymentStages =
        range === "all"
          ? []
          : [
              {
                $match: {
                  paymentDate: {
                    $gte: previousPeriodStart,
                    $lt: periodStart,
                  },
                },
              },
            ];

      const revenuePipeline = [
        {
          $addFields: {
            paymentDate: {
              $convert: {
                input: "$paidAt",
                to: "date",
                onError: null,
                onNull: null,
              },
            },

            revenueAmount: {
              $convert: {
                input: "$amount",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
        {
          $match: {
            paymentStatus: "paid",
            paymentDate: {
              $ne: null,
              $lte: now,
            },
          },
        },
        {
          $facet: {
            // Current selected period
            summary: [
              ...currentPaymentStages,
              {
                $group: {
                  _id: null,
                  totalRevenue: {
                    $sum: "$revenueAmount",
                  },
                  firstPaymentDate: {
                    $min: "$paymentDate",
                  },
                },
              },
            ],

            // Daily or monthly chart buckets
            buckets: [
              ...currentPaymentStages,
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: revenueDateFormat,
                      date: "$paymentDate",
                      timezone: "UTC",
                    },
                  },
                  revenue: {
                    $sum: "$revenueAmount",
                  },
                },
              },
              {
                $sort: { _id: 1 },
              },
            ],

            // Immediately preceding equivalent period
            previousSummary: [
              ...previousPaymentStages,
              {
                $group: {
                  _id: null,
                  totalRevenue: {
                    $sum: "$revenueAmount",
                  },
                },
              },
            ],
          },
        },
      ];

      // --------------------------------------------------
      // 5. FETCH ALL DASHBOARD DATA
      // --------------------------------------------------

      const [
        totalUsers,
        totalTechnicians,
        pendingServices,
        bookingAggregation,
        revenueAggregation,
      ] = await Promise.all([
        // Registered users during the selected period.
        usersCollection.countDocuments(dateFilter),

        // Technicians registered during the selected period.
        usersCollection.countDocuments({
          ...dateFilter,
          role: "technician",
        }),

        // Services created during the period that are still pending.
        servicesCollection.countDocuments({
          ...dateFilter,
          approvalStatus: "pending",
        }),

        bookingsCollection
          .aggregate(bookingPipeline)
          .toArray(),

        paymentsCollection
          .aggregate(revenuePipeline)
          .toArray(),
      ]);

      // --------------------------------------------------
      // 6. PREPARE BOOKING ACTIVITY
      // --------------------------------------------------

      const bookingResult = bookingAggregation[0] || {
        summary: [],
        buckets: [],
      };

      const bookingSummary = bookingResult.summary[0] || {
        totalBookings: 0,
        firstBookingDate: null,
      };

      const totalBookings = bookingSummary.totalBookings;

      const bookingMap = new Map(
        bookingResult.buckets.map((item) => [
          item._id,
          item.bookings,
        ])
      );

      const bookingData = [];

      let bookingDays = 0;

      if (range === "all") {
        // All Time: monthly buckets.
        if (bookingSummary.firstBookingDate) {
          const firstDate = new Date(
            bookingSummary.firstBookingDate
          );

          const cursor = new Date(
            Date.UTC(
              firstDate.getUTCFullYear(),
              firstDate.getUTCMonth(),
              1
            )
          );

          const lastMonth = new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              1
            )
          );

          while (cursor <= lastMonth) {
            const year = cursor.getUTCFullYear();

            const month = String(
              cursor.getUTCMonth() + 1
            ).padStart(2, "0");

            const key = `${year}-${month}`;

            bookingData.push({
              date: `${key}-01`,
              bookings: bookingMap.get(key) || 0,
            });

            cursor.setUTCMonth(cursor.getUTCMonth() + 1);
          }

          const firstDay = Date.UTC(
            firstDate.getUTCFullYear(),
            firstDate.getUTCMonth(),
            firstDate.getUTCDate()
          );

          const currentDay = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate()
          );

          bookingDays =
            Math.floor(
              (currentDay - firstDay) / DAY_IN_MS
            ) + 1;
        }
      } else {
        // Last 7 / 30 days: daily buckets.
        const cursor = new Date(periodStart);

        for (let index = 0; index < days; index++) {
          const key = cursor.toISOString().slice(0, 10);

          bookingData.push({
            date: key,
            bookings: bookingMap.get(key) || 0,
          });

          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }

        bookingDays = days;
      }

      const averagePerDay =
        bookingDays > 0
          ? Math.round(
              (totalBookings / bookingDays) * 10
            ) / 10
          : 0;

      const bookingActivity = {
        totalBookings,
        averagePerDay,
        data: bookingData,
      };

      // --------------------------------------------------
      // 7. PREPARE REVENUE OVERVIEW
      // --------------------------------------------------

      const revenueResult = revenueAggregation[0] || {
        summary: [],
        buckets: [],
        previousSummary: [],
      };

      const revenueSummary = revenueResult.summary[0] || {
        totalRevenue: 0,
        firstPaymentDate: null,
      };

      const totalRevenue = revenueSummary.totalRevenue;

      const previousRevenue =
        revenueResult.previousSummary[0]?.totalRevenue ?? 0;

      let percentageChange = null;

      if (
        range !== "all" &&
        previousRevenue > 0
      ) {
        percentageChange =
          Math.round(
            ((totalRevenue - previousRevenue) /
              previousRevenue) *
              1000
          ) / 10;
      }

      const revenueMap = new Map(
        revenueResult.buckets.map((item) => [
          item._id,
          item.revenue,
        ])
      );

      const revenueData = [];

      if (range === "all") {
        // All Time: monthly revenue buckets.
        if (revenueSummary.firstPaymentDate) {
          const firstDate = new Date(
            revenueSummary.firstPaymentDate
          );

          const cursor = new Date(
            Date.UTC(
              firstDate.getUTCFullYear(),
              firstDate.getUTCMonth(),
              1
            )
          );

          const lastMonth = new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              1
            )
          );

          while (cursor <= lastMonth) {
            const year = cursor.getUTCFullYear();

            const month = String(
              cursor.getUTCMonth() + 1
            ).padStart(2, "0");

            const key = `${year}-${month}`;

            revenueData.push({
              date: `${key}-01`,
              revenue:
                Math.round(
                  (revenueMap.get(key) || 0) * 100
                ) / 100,
            });

            cursor.setUTCMonth(cursor.getUTCMonth() + 1);
          }
        }
      } else {
        // Last 7 / 30 days: daily revenue buckets.
        const cursor = new Date(periodStart);

        for (let index = 0; index < days; index++) {
          const key = cursor.toISOString().slice(0, 10);

          revenueData.push({
            date: key,
            revenue:
              Math.round(
                (revenueMap.get(key) || 0) * 100
              ) / 100,
          });

          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }

      const revenueOverview = {
        totalRevenue:
          Math.round(totalRevenue * 100) / 100,

        previousRevenue:
          Math.round(previousRevenue * 100) / 100,

        percentageChange,

        data: revenueData,
      };

      // --------------------------------------------------
      // 8. SEND COMPLETE RESPONSE
      // --------------------------------------------------

      return res.status(200).send({
        success: true,
        range,

        period: {
          start: periodStart,
          end: now,
        },

        stats: {
          totalUsers,
          totalTechnicians,
          pendingServices,
        },

        bookingActivity,
        revenueOverview,
      });
    } catch (error) {
      console.error(
        "Admin dashboard overview error:",
        error
      );

      return res.status(500).send({
        success: false,
        message: "Failed to load admin dashboard statistics.",
      });
    }
  }
);





//admin mange user page api
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const allowedRoles = ["customer", "technician", "admin"];

    const role =
      typeof req.query.role === "string"
        ? req.query.role
        : "all";

    if (role !== "all" && !allowedRoles.includes(role)) {
      return res.status(400).send({
        success: false,
        message: "Invalid role filter.",
      });
    }

    const filter = role === "all" ? {} : { role };

    const adminEmail = String(req.user.email || "")
      .trim()
      .toLowerCase();

    const [userDocs, totalUsers] = await Promise.all([
      usersCollection
        .find(filter, {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            createdAt: 1,
          },
        })
        .sort({ createdAt: -1, _id: -1 })
        .toArray(),

      usersCollection.countDocuments({}),
    ]);

    const users = userDocs.map((user) => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      image: user.image || null,
      role: user.role || "customer",
      joinedAt: user.createdAt || null,
      isCurrentUser:
        String(user.email || "").trim().toLowerCase() === adminEmail,
    }));

    res.send({
      success: true,
      totalUsers,
      users,
    });
  } catch (error) {
    console.error("Get admin users error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to retrieve users.",
    });
  }
});



//update a user role
app.patch("/admin/users/:id/role",verifyToken,verifyAdmin,async (req, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;

      const allowedRoles = ["customer", "technician", "admin"];

      if (!allowedRoles.includes(role)) {
        return res.status(400).send({
          success: false,
          message: "Invalid user role.",
        });
      }


      const adminEmail = req.user.email

      if (!adminEmail) {
        return res.status(401).send({
          success: false,
          message: "Authentication information is missing.",
        });
      }


      const targetUser = await usersCollection.findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            email: 1,
            role: 1,
          },
        }
      );

      if (!targetUser) {
        return res.status(404).send({
          success: false,
          message: "User not found.",
        });
      }


      const targetEmail = String(targetUser.email || "")
        .trim()
        .toLowerCase();

      if (targetEmail === adminEmail) {
        return res.status(403).send({
          success: false,
          message: "You cannot change your own role.",
        });
      }


      if (targetUser.role === role) {
        return res.send({
          success: true,
          message: "User already has this role.",
          role,
        });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            role,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          success: false,
          message: "User no longer exists.",
        });
      }

      res.send({
        success: true,
        message: "User role updated successfully.",
        role,
      });
    } catch (error) {
      console.error("Update user role error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to update user role.",
      });
    }
  }
);




//for service-approval page
app.get("/admin/services", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status = "all", category = "all" } = req.query;

    const filter = {};

    if (category !== "all") filter.category = category;

    const allServices = await servicesCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    //calculate status count
    const counts = {
      all: allServices.length,
      pending: allServices.filter(s => s.approvalStatus === "pending").length,
      approved: allServices.filter(s => s.approvalStatus === "approved").length,
      rejected: allServices.filter(s => s.approvalStatus === "rejected").length,
    };

    //put pending services first
    allServices.sort((a, b) => {
      const order = { pending: 0, approved: 1, rejected: 2 };
      return (order[a.approvalStatus] ?? 3) -
             (order[b.approvalStatus] ?? 3);
    });

    //apply status filter
    const filteredServices =
      status === "all"
        ? allServices
        : allServices.filter(s => s.approvalStatus === status);

    const services = filteredServices.map(({ _id, ...service }) => ({
      ...service,
      id: _id.toString(),
    }));

    const categories = await servicesCollection.distinct("category");

    res.send({
      success: true,
      services,
      categories,
      counts,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to retrieve services.",
    });
  }
});


//approve reject service
app.patch("/admin/services/:id/approval", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalStatus, rejectionReason } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid service ID." });
    }

    if (!["approved", "rejected"].includes(approvalStatus)) {
      return res.status(400).send({ message: "Invalid approval status." });
    }

    if (approvalStatus === "rejected" && !rejectionReason?.trim()) {
      return res.status(400).send({ message: "Rejection reason is required." });
    }

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          approvalStatus,
          rejectionReason: approvalStatus === "rejected" ? rejectionReason.trim() : null,
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({ message: "Service not found." });
    }

    res.send({
      success: true,
      message: `Service ${approvalStatus} successfully.`,
      approvalStatus,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update service." });
  }
});




//api for booking page in admin dashrboa
app.get("/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({})
      .sort({ preferredDate: 1 })
      .toArray();

    res.send({
      success: true,
      totalBookings: bookings.length,
      bookings,
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      success: false,
      message: "Failed to retrieve bookings.",
    });
  }
});



//api for admin dashboard transactions
app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { range = "all" } = req.query;
    const now = new Date();

    let startDate = null;

    if (range === "today") {
      startDate = new Date(now);
      startDate.setUTCHours(0, 0, 0, 0);
    } else if (range === "7d") {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === "30d") {
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (range !== "all") {
      return res.status(400).send({
        success: false,
        message: "Invalid date range.",
      });
    }

    const filter = startDate
      ? { paidAt: { $gte: startDate, $lte: now } }
      : {};

    const transactions = await paymentsCollection
      .find(filter)
      .sort({ paidAt: -1 })
      .toArray();

    const totalRevenue = transactions.reduce((total, payment) => {
      if (payment.paymentStatus !== "paid") return total;

      const amount = Number(payment.amount);
      return Number.isFinite(amount) ? total + amount : total;
    }, 0);

    res.send({
      success: true,
      totalRevenue,
      transactions,
    });
  } catch (error) {
    console.error("Get admin transactions error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to retrieve transactions.",
    });
  }
});

























// // Get all users
// app.get('/users', async (req, res) => {
//     try {
//         const users = await usersCollection.find().toArray();
//         res.json(users);
//     } catch (error) {
//         console.error('Error fetching users:', error);
//         res.status(500).json({ error: 'Internal Server Error' });
//     }
// });



// //update role (admin api)
// app.patch('/update/user/:id', async (req, res) => {
//     const { id } = req.params;

//     const result = await usersCollection.updateOne(
//         { _id: new ObjectId(id) },
//         { $set: { accountType: req.body.accountType } }
//     );

//     res.send(result);
// });


// app.get('/admin/all-services', async (req, res) => {
//     const results = await servicesCollection.aggregate([
//         {
//             $addFields: {
//                 statusPriority: {
//                     $switch: {
//                         branches: [
//                             { case: { $eq: ["$approvalStatus", "pending"] }, then: 1 },
//                             { case: { $eq: ["$approvalStatus", "approved"] }, then: 2 },
//                             { case: { $eq: ["$approvalStatus", "rejected"] }, then: 3 }
//                         ],
//                         default: 99
//                     }
//                 }
//             }
//         },
//         {
//             // Sort by custom status priority ascending, then createdAt descending
//             $sort: { statusPriority: 1, createdAt: -1 }
//         },
//         {
//             // Remove the temporary helper field before sending the response
//             $project: { statusPriority: 0 }
//         }
//     ]).toArray();

//     res.send(results);
// });














//----------------^^^------------All ADIMIN APIs------^^^-----------------------------------//


app.listen(PORT, () => {
    console.log("server is running at port", PORT);
});