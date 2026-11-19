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


//---------------------------------All MiddleWire-------------------------------------------------------//
app.use(cors());

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
  if (req.user?.role !== "customer") {
    return res.status(403).send({
      message: "Access denied. Customers only.",
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
const stripeEventsCollection = db.collection("stripeEvents");
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

// Prevent the same Stripe webhook event from being processed twice.
await stripeEventsCollection.createIndex(
  { eventId: 1 },
  {
    unique: true,
    name: "unique_stripe_event",
  }
);

//-----------------^^^-------indexes-----^^^----------------------------//







//---------------------------------ALL Stripe, Payment, Premium Ures Related APIs--------------------------//



// Create Stripe Checkout Session for a completed booking
app.post("/api/payments/create-checkout-session",verifyToken,verifyCustomer,async (req, res) => {
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





// Convert a Stripe expandable field (string or object) into an ID.
// function getStripeObjectId(value) {
//     if (typeof value === "string") return value;
//     return value?.id ?? null;
// }

// Get the subscription ID from an invoice across Stripe API object formats.
// function getInvoiceSubscriptionId(invoice) {
//     const subscription =
//         invoice.parent?.subscription_details?.subscription ??
//         invoice.subscription ??
//         null;

//     return getStripeObjectId(subscription);
// }

// // Validate the metadata added by lib/payments/checkout.ts.
// function getPlanInfoFromMetadata(metadata) {
//     const userId = metadata?.userId;
//     const accountType = metadata?.accountType;
//     const planId = metadata?.planId;

//     const expectedPlanId =
//         accountType === "seeker"
//             ? "seeker_pro"
//             : accountType === "recruiter"
//                 ? "recruiter_pro"
//                 : null;

//     if (
//         typeof userId !== "string" ||
//         !ObjectId.isValid(userId) ||
//         !expectedPlanId ||
//         planId !== expectedPlanId
//     ) {
//         return null;
//     }

//     return {
//         userId,
//         userObjectId: new ObjectId(userId),
//         accountType,
//         proPlanId: expectedPlanId,
//         freePlanId: accountType === "seeker" ? "seeker_free" : "recruiter_free",
//     };
// }

// // Keep the user's HireLoop plan in sync with the Stripe subscription status.
// async function updateUserSubscription(subscription) {
//     const planInfo = getPlanInfoFromMetadata(subscription.metadata);

//     if (!planInfo) {
//         console.warn(
//             "Stripe subscription has missing or invalid HireLoop metadata:",
//             subscription.id
//         );
//         return null;
//     }

//     const subscriptionStatus = subscription.status;
//     const hasProAccess = ["active", "trialing"].includes(subscriptionStatus);

//     const result = await usersCollection.updateOne(
//         { _id: planInfo.userObjectId },
//         {
//             $set: {
//                 planId: hasProAccess ? planInfo.proPlanId : planInfo.freePlanId,
//                 subscriptionStatus,
//                 stripeCustomerId: getStripeObjectId(subscription.customer),
//                 stripeSubscriptionId: subscription.id,
//                 cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
//                 updatedAt: new Date(),
//             },
//         }
//     );

//     if (result.matchedCount === 0) {
//         throw new Error(`No HireLoop user found for Stripe subscription ${subscription.id}`);
//     }

//     return planInfo;
// }





// // Stripe webhook. This route MUST be registered before express.json().
// app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
//     const signature = req.headers["stripe-signature"];

//     if (!process.env.STRIPE_WEBHOOK_SECRET) {
//         console.error("STRIPE_WEBHOOK_SECRET is missing from the backend .env file.");
//         return res.status(500).send("Webhook secret is not configured.");
//     }

//     if (typeof signature !== "string") {
//         return res.status(400).send("Missing Stripe signature.");
//     }

//     let event;

//     // Verify that the request genuinely came from Stripe.
//     try {
//         event = stripe.webhooks.constructEvent(
//             req.body,
//             signature,
//             process.env.STRIPE_WEBHOOK_SECRET
//         );
//     } catch (error) {
//         console.error("Stripe webhook signature verification failed:", error.message);
//         return res.status(400).send(`Webhook Error: ${error.message}`);
//     }

//     try {
//         // Stripe can retry event deliveries. Skip events already processed.
//         const alreadyProcessed = await stripeEventsCollection.findOne({
//             eventId: event.id,
//         });

//         if (alreadyProcessed) {
//             return res.status(200).json({ received: true, duplicate: true });
//         }

//         const eventObject = event.data.object;

//         switch (event.type) {
//             case "checkout.session.completed": {
//                 const session = eventObject;

//                 if (session.mode !== "subscription") break;

//                 const planInfo = getPlanInfoFromMetadata(session.metadata);

//                 if (!planInfo) {
//                     console.warn("Checkout session has missing or invalid HireLoop metadata:", session.id);
//                     break;
//                 }

//                 const updateResult = await usersCollection.updateOne(
//                     { _id: planInfo.userObjectId },
//                     {
//                         $set: {
//                             stripeCustomerId: getStripeObjectId(session.customer),
//                             stripeSubscriptionId: getStripeObjectId(session.subscription),
//                             updatedAt: new Date(),
//                         },
//                     }
//                 );

//                 if (updateResult.matchedCount === 0) {
//                     throw new Error(`No HireLoop user found for Checkout Session ${session.id}`);
//                 }

//                 // Do not grant Pro access from this event alone.
//                 // invoice.paid / customer.subscription.updated will sync entitlement.
//                 break;
//             }

//             case "invoice.paid": {
//                 const invoice = eventObject;
//                 const subscriptionId = getInvoiceSubscriptionId(invoice);

//                 if (!subscriptionId) break;

//                 const subscription = await stripe.subscriptions.retrieve(subscriptionId);
//                 const planInfo = await updateUserSubscription(subscription);

//                 if (planInfo) {
//                     // Save one payment record per Stripe invoice.
//                     await paymentsCollection.updateOne(
//                         { stripeInvoiceId: invoice.id },
//                         {
//                             $setOnInsert: {
//                                 stripeInvoiceId: invoice.id,
//                                 stripeSubscriptionId: subscription.id,
//                                 stripeCustomerId: getStripeObjectId(invoice.customer),
//                                 userId: planInfo.userId,
//                                 amountPaid: invoice.amount_paid,
//                                 currency: invoice.currency,
//                                 status: "paid",
//                                 createdAt: invoice.created
//                                     ? new Date(invoice.created * 1000)
//                                     : new Date(),
//                             },
//                         },
//                         { upsert: true }
//                     );
//                 }

//                 break;
//             }

//             case "invoice.payment_failed": {
//                 const invoice = eventObject;
//                 const subscriptionId = getInvoiceSubscriptionId(invoice);

//                 if (!subscriptionId) break;

//                 const subscription = await stripe.subscriptions.retrieve(subscriptionId);

//                 // Use Stripe's current subscription state. This also avoids an older
//                 // payment_failed event overriding a newer successful payment.
//                 await updateUserSubscription(subscription);
//                 break;
//             }

//             case "customer.subscription.created":
//             case "customer.subscription.updated":
//             case "customer.subscription.deleted": {
//                 // Retrieve the latest state instead of trusting a possibly out-of-order event snapshot.
//                 const eventSubscription = eventObject;
//                 const currentSubscription = await stripe.subscriptions.retrieve(eventSubscription.id);
//                 await updateUserSubscription(currentSubscription);
//                 break;
//             }

//             default:
//                 // Ignore event types not used by HireLoop.
//                 break;
//         }

//         // Save the event only after its work succeeds. Failed requests can then be retried by Stripe.
//         try {
//             await stripeEventsCollection.insertOne({
//                 eventId: event.id,
//                 eventType: event.type,
//                 processedAt: new Date(),
//             });
//         } catch (error) {
//             // Two simultaneous deliveries can race after both pass the initial lookup.
//             if (error.code !== 11000) throw error;
//         }

//         return res.status(200).json({ received: true });
//     } catch (error) {
//         console.error("Stripe webhook processing error:", error);
//         return res.status(500).json({ received: false });
//     }
// });



// // Register normal JSON parsing AFTER the Stripe raw-body route.
// app.use(express.json());


// // Legacy one-time checkout verification endpoint.
// // The new subscription flow must use the Stripe webhook instead.
// //stripe payment varify and user update
// app.post('/payment/checkout-verify', async (req, res) => {
//     const { sessionId } = req.body;

//     const {
//         status,
//         customer_email,
//         metadata,
//         payment_intent,
//         payment_status, } =

//         await stripe.checkout.sessions.retrieve(sessionId);

//         // console.log("statu",status)



//     // 1. Prevent duplicate processing: check if sessionId already exists in the database
//         const paymentAlreadyExists = await paymentsCollection.findOne({sessionId});
//         if(paymentAlreadyExists){
//             return res.send({message: 'payment already verified', success:false})
//         }
//     // 2. Verify ownership: confirm the session belongs to the currently authenticated user
        
//     // 3. Record payment: insert the verified session details into the payments collection
    
//     if(status==='complete' && payment_status==='paid'){

//         const paymentData = { 
//             sessionId,
//             status,
//             customer_email,
//             userId: metadata.customer_Id,
//             payment_intent,
//             payment_status,
//         }
    
//         const result = await paymentsCollection.insertOne(paymentData);
        

//         // 4. update user info as premium user
//         const updateResult = await usersCollection.updateOne(
//             {_id: new ObjectId(metadata.customer_Id)},
//             {$set:{ premium : true}}
//         );

//         res.send({result,updateResult, success: true});
//         return;
//     }

//     res.send({message : 'payment varification failed', success: false});

// });


// //is user premium by id
// app.get('/premium-user/:id',async(req,res)=>{
//     const {id} = req.params;
//     console.log({id});
//     const result = await usersCollection.findOne(
//         {_id: new ObjectId(id)},
//         {projection: {premium: 1, _id: 0 }}    
//     );
//     // res.send({result})
//     res.send(Boolean(result?.premium));
// });


//-------------------^^^-------ALL Stripe, Payment, Premium Ures Related APIs---------^^^-----------------//






//---------------------------------All Service API-----------------------------//

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




//----------------------------^^-----All Service API-------^^^----------------------//




//---------------------------------All Customer API-----------------------------//


app.get('/customer/bookings/dashboard/:email', async (req,res) => {
    const {email} = req.params;
    
  const results = await bookingsCollection.find({customerEmail: email}).sort({ createdAt: -1 }).limit(5).toArray();

  res.send(results);
});

app.get('/customer/bookings/:email/count-req-prog-comp', async (req, res) => {
  const { email } = req.params;

  const [requested, inProgress, completed] = await Promise.all([
    bookingsCollection.countDocuments({ customerEmail: email, status: "requested" }),
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
app.patch("/customer/bookings/:id/cancel",async (req, res) => {
    try {
      const { id } = req.params;

      const bookingId = new ObjectId(id);

      

      const result = await bookingsCollection.updateOne(
        {_id: bookingId,status: "requested"},
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
app.get("/customer/all-bookings/:email",async (req, res) => {
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


//----------------------------^^-----All Customer API-------^^^----------------------//












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
app.patch('/update/user/:id', async(req,res)=>{
    const {id} = req.params;

    const result = await usersCollection.updateOne(
        {_id : new ObjectId(id)},
        {$set:{accountType: req.body.accountType}}
    );

    res.send(result);
});



//----------------^^^------------All ADIMIN APIs------^^^-----------------------------------//


app.listen(PORT, () => {
    console.log("server is running at port", PORT);
});