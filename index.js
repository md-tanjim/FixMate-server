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







//---------------------------------ALL Stripe, Payment, Premium Ures Related APIs--------------------------//



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











//----------------------------^^-----All Service API-------^^^----------------------//




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







//----------------------------^^-----All Technician API-------^^^----------------------//



//----------------------------All ADIMIN APIs-----------------------------------------//

// Get all users
app.get('/users', async (req, res) => {
    try {
        const users = await usersCollection.find().toArray();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



//update role (admin api)
app.patch('/update/user/:id', async (req, res) => {
    const { id } = req.params;

    const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { accountType: req.body.accountType } }
    );

    res.send(result);
});


app.get('/admin/all-services', async (req, res) => {
    const results = await servicesCollection.aggregate([
        {
            $addFields: {
                statusPriority: {
                    $switch: {
                        branches: [
                            { case: { $eq: ["$approvalStatus", "pending"] }, then: 1 },
                            { case: { $eq: ["$approvalStatus", "approved"] }, then: 2 },
                            { case: { $eq: ["$approvalStatus", "rejected"] }, then: 3 }
                        ],
                        default: 99
                    }
                }
            }
        },
        {
            // Sort by custom status priority ascending, then createdAt descending
            $sort: { statusPriority: 1, createdAt: -1 }
        },
        {
            // Remove the temporary helper field before sending the response
            $project: { statusPriority: 0 }
        }
    ]).toArray();

    res.send(results);
});


//----------------^^^------------All ADIMIN APIs------^^^-----------------------------------//


app.listen(PORT, () => {
    console.log("server is running at port", PORT);
});