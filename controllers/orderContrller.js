// controllers/orderController.js
const Order = require("../models/order");
const User = require("../models/user");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { sendReceiptEmail } = require("../services/recieptUtils");
const { sendEmail } = require("../services/emailUtil");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { upload } = require("../config/s3");
const path = require("path");
const axios = require("axios");



/**
 * Creates a user account for anonymous donors and sends credentials email
 * @param {Object} donorDetails - Donor information from the order
 * @param {String} donationId - The donation ID to include in the email
 * @returns {Object} The created user or null if creation failed
 */
const createUserForDonor = async (donorDetails, donationId) => {
  try {
    // Check if user with this email already exists
    const existingUser = await User.findOne({ email: donorDetails.email });

    if (existingUser) {
      console.log(
        `User with email ${donorDetails.email} already exists, skipping creation`
      );
      return existingUser;
    }

    // Generate a random password
    const password = crypto.randomBytes(8).toString("hex");

    const hashedPassword = await bcrypt.hash(password, 10);
    // Create new user
    const newUser = new User({
      email: donorDetails.email,
      password: hashedPassword,
      name: donorDetails.name,
      phone: donorDetails.phone,
      role: "user",
    });

    // Save the user
    await newUser.save();
    console.log(`Created new user account for donor: ${donorDetails.email}`);

    // Send welcome email with credentials
    const loginUrl =
      "https://shahidafridifoundation.org.au/login";

    const emailSubject =
      "Welcome to Shahid Afridi Foundation - Your Account Details";
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      
        
        <h2 style="color: #4CAF50; text-align: center;">Thank You for Your Donation!</h2>
        
        <p>Dear ${donorDetails.name},</p>
        
        <p>Thank you for your generous donation (ID: <strong>${donationId}</strong>) to the Shahid Afridi Foundation. Your contribution will help us make a meaningful difference in the lives of those in need.</p>
        
        <p>We've created an account for you so you can easily track your donations and manage your giving in the future.</p>
        
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Your Account Details:</strong></p>
          <p>Email: ${donorDetails.email}</p>
          <p>Password: ${password}</p>
          <p style="font-size: 12px; color: #666;">Please keep this information secure. We recommend changing your password after your first login.</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${loginUrl}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">Login to Your Account</a>
        </div>
        
        <p>If you have any questions or need assistance, please don't hesitate to contact our team.</p>
        
        <p>Warm regards,<br>The Shahid Afridi Foundation Team</p>
        
        <div style="font-size: 12px; color: #666; border-top: 1px solid #e0e0e0; margin-top: 20px; padding-top: 20px;">
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    `;

    await sendEmail(donorDetails.email, emailBody, emailSubject);
    console.log(`Sent welcome email to: ${donorDetails.email}`);

    return newUser;
  } catch (error) {
    console.error("Error creating user for donor:", error);
    return null;
  }
};
/**
 * Generates a unique donation ID with optional user donor prefix
 * @param {Object} user - The user object (optional)
 * @returns {string} - Unique donation ID in format: UUUUNNNN where U=User ID digits, N=Random number
 */
const generateDonationId = (user = null) => {
  const date = new Date();

  // Generate the user/donor prefix (4 characters)
  let userPrefix = "";

  if (user && user._id) {
    // If user exists, use the last 4 characters of their ID
    const userId = user._id.toString();
    userPrefix = userId.substring(Math.max(0, userId.length - 4));
  } else {
    // Otherwise, generate 4 random characters
    userPrefix = Math.floor(1000 + Math.random() * 9000).toString();
  }

  // Generate 4 random digits for the donation part
  const randomNum = Math.floor(1000 + Math.random() * 9000).toString();

  // Combine to create full donation ID
  return `${userPrefix}${randomNum}`;
};

/**
 * Generates a donation ID with a retry mechanism in case of collision
 * @param {Function} checkExistsFn - Function that checks if ID exists, returns Promise<boolean>
 * @param {Object} user - The user object (optional)
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<string>} - A unique donation ID
 */
const generateUniqueDonationId = async (
  checkExistsFn,
  user = null,
  maxRetries = 3
) => {
  let retries = 0;

  while (retries < maxRetries) {
    const donationId = generateDonationId(user);

    // Check if this ID already exists
    const exists = await checkExistsFn(donationId);

    if (!exists) {
      return donationId;
    }

    retries++;
  }

  throw new Error(
    "Failed to generate unique donation ID after multiple attempts"
  );
};

// exports.createOrder = async (req, res) => {
//   try {
//     const {
//       items,
//       paymentType,
//       adminCostContribution,
//       donorDetails,
//       paymentMethod,
//       totalAmount,
//       recurringDetails,
//       installmentDetails,
//       stripePaymentMethodId,
//       updateUserDetails,
//     } = req.body;

//     console.log("Received order data:", req.body);

//     // Validate required fields
//     if (!items || !paymentType || !donorDetails) {
//       return res.status(400).json({
//         status: "Error",
//         message: "Missing required fields",
//       });
//     }

//     // Get user from request
//     const user = req.user;

//     // Update user details if needed
//     if (user && (updateUserDetails || donorDetails.rememberDetails)) {
//       try {
//         // Update user with donor details
//         const userUpdates = {
//           name: donorDetails.name,
//           phone: donorDetails.phone,
//           // Don't update email if user already has one
//           // email: donorDetails.email,
//           address: {
//             street: donorDetails.streetAddress,
//             city: donorDetails.townCity,
//             state: donorDetails.state,
//             postalCode: donorDetails.postcode,
//           },
//         };

//         await User.findByIdAndUpdate(user._id, userUpdates);
//         console.log(`Updated user details for user ${user._id}`);
//       } catch (userUpdateError) {
//         console.error("Error updating user details:", userUpdateError);
//         // Don't fail the order if user update fails
//       }
//     }

//     // Generate unique donation ID with user info
//     const donationId = await generateUniqueDonationId(async (id) => {
//       // Check if ID exists in database
//       const existingOrder = await Order.findOne({ donationId: id });
//       return !!existingOrder;
//     }, user);

//     // Validate recurring payment details
//     if (paymentType === "recurring") {
//       if (
//         !recurringDetails ||
//         !recurringDetails.frequency ||
//         !recurringDetails.amount
//       ) {
//         return res.status(400).json({
//           status: "Error",
//           message: "Recurring payment requires frequency and amount",
//         });
//       }

//       const validFrequencies = ["daily", "weekly", "monthly", "yearly"];
//       if (!validFrequencies.includes(recurringDetails.frequency)) {
//         return res.status(400).json({
//           status: "Error",
//           message: "Invalid frequency for recurring payment",
//         });
//       }
//     }

//     // Validate installment payment details
//     if (paymentType === "installments") {
//       if (
//         !installmentDetails ||
//         !installmentDetails.numberOfInstallments ||
//         !installmentDetails.installmentAmount
//       ) {
//         return res.status(400).json({
//           status: "Error",
//           message:
//             "Installment payment requires numberOfInstallments and installmentAmount",
//         });
//       }

//       // Validate number of installments (1-12 months)
//       if (
//         installmentDetails.numberOfInstallments < 1 ||
//         installmentDetails.numberOfInstallments > 12
//       ) {
//         return res.status(400).json({
//           status: "Error",
//           message: "Number of installments must be between 1 and 12",
//         });
//       }
//     }

//     if (donorDetails.rememberDetails && user) {
//       await User.findByIdAndUpdate(user._id, {
//         name: donorDetails.name,
//         phone: donorDetails.phone,
//         email: donorDetails.email,
//         address: {
//           street: donorDetails.streetAddress,
//           city: donorDetails.townCity,
//           state: donorDetails.state,
//           postcode: donorDetails.postcode,
//         },
//       });
//     }

//     // Process items array
//     const processedItems = items.map((item) => ({
//       title: item.title,
//       price: item.price,
//       quantity: item.quantity || 1,
//       onBehalfOf: item.onBehalfOf || null,
//     }));

//     // Prepare recurring details if applicable
//     let orderRecurringDetails = null;
//     if (paymentType === "recurring") {
//       orderRecurringDetails = {
//         frequency: recurringDetails.frequency,
//         amount: recurringDetails.amount,
//         startDate: new Date(),
//         status: "active",
//         nextPaymentDate: calculateNextPaymentDate(
//           new Date(),
//           recurringDetails.frequency
//         ),
//         totalPayments: 0,
//         paymentHistory: [],
//       };
//     }

//     // Prepare installment details if applicable
//     let orderInstallmentDetails = null;
//     if (paymentType === "installments") {
//       // Calculate interval in days between payments (30 days for monthly)
//       const paymentIntervalDays = 30;

//       orderInstallmentDetails = {
//         numberOfInstallments: installmentDetails.numberOfInstallments,
//         installmentAmount: installmentDetails.installmentAmount,
//         startDate: new Date(),
//         status: "active",
//         installmentsPaid: 0,
//         nextInstallmentDate: new Date(),
//         installmentHistory: [],
//         paymentIntervalDays: paymentIntervalDays,
//       };
//     }

//     // Create order with donationId
//     const order = new Order({
//       user: user ? user._id : null,
//       donationId,
//       items: processedItems,
//       paymentType,
//       adminCostContribution: {
//         included: !!adminCostContribution,
//         amount: adminCostContribution || 0,
//       },
//       donorDetails: {
//         name: donorDetails.name,
//         phone: donorDetails.phone,
//         email: donorDetails.email,
//         address: {
//           street: donorDetails.streetAddress,
//           city: donorDetails.townCity,
//           state: donorDetails.state,
//           postcode: donorDetails.postcode,
//         },
//         agreeToMessages: donorDetails.agreeToMessages,
//       },
//       paymentMethod,
//       paymentStatus: paymentMethod === "bank" ? "pending" : "processing",
//       totalAmount,
//       recurringDetails: orderRecurringDetails,
//       installmentDetails: orderInstallmentDetails,
//       transactionDetails: {},
//     });

//     // Attempt to save with retries in case of donationId collision
//     let savedOrder = null;
//     let retries = 3;

//     while (retries > 0) {
//       try {
//         savedOrder = await order.save();
//         break;
//       } catch (error) {
//         if (error.code === 11000 && error.keyPattern.donationId) {
//           // Duplicate donationId, generate a new one and retry
//           order.donationId = `D${year}${month}${Math.floor(
//             Math.random() * 10000
//           )
//             .toString()
//             .padStart(4, "0")}`;
//           retries--;
//         } else {
//           throw error;
//         }
//       }
//     }

//     if (!savedOrder) {
//       throw new Error(
//         "Failed to generate unique donation ID after multiple attempts"
//       );
//     }

//     console.log("Order saved:", savedOrder);

//     if (!user && donorDetails.email) {
//       try {
//         const newUser = await createUserForDonor(
//           donorDetails,
//           savedOrder.donationId
//         );

//         if (newUser) {
//           // Link the order to the newly created user
//           savedOrder.user = newUser._id;
//           await savedOrder.save();
//           console.log(
//             `Linked order ${savedOrder._id} to new user ${newUser._id}`
//           );
//         }
//       } catch (userCreateError) {
//         // Log error but don't fail the order
//         console.error(
//           "Failed to create user account for donor:",
//           userCreateError
//         );
//       }
//     }

//     // Process payment with Stripe if card is selected
//     if (paymentMethod === "card" && stripePaymentMethodId) {
//       try {
//         if (paymentType === "single") {
//           // Process one-time payment
//           const paymentIntent = await stripe.paymentIntents.create({
//             amount: Math.round(totalAmount * 100),
//             currency: "aud",
//             payment_method: stripePaymentMethodId,
//             confirm: true,
//             off_session: true,
//             description: `Donation ${savedOrder.donationId}`,
//             metadata: {
//               donationId: savedOrder.donationId,
//               orderId: savedOrder._id.toString(),
//             },
//           });

//           // Update order with payment intent details
//           savedOrder.transactionDetails = {
//             stripePaymentMethodId,
//             stripePaymentIntentId: paymentIntent.id,
//             stripeStatus: paymentIntent.status,
//             clientSecret: paymentIntent.client_secret,
//           };

//           // Update payment status based on Stripe status
//           if (paymentIntent.status === "succeeded") {
//             // Send receipt email for completed payments
//             try {
//               await sendReceiptEmail(savedOrder);
//             } catch (emailError) {
//               console.error("Failed to send receipt email:", emailError);
//               // Don't fail the order if email fails
//             }
//             savedOrder.paymentStatus = "completed";
//           } else if (paymentIntent.status === "requires_action") {
//             savedOrder.paymentStatus = "requires_action";
//           }

//           await savedOrder.save();
//         }
//         // Handle different payment types
//         else if (paymentType === "recurring") {
//           // IMPROVED PAYMENT METHOD HANDLING
//           let customer;

//           try {
//             // First, try to retrieve the payment method
//             const paymentMethod = await stripe.paymentMethods.retrieve(
//               stripePaymentMethodId
//             );

//             // If it's already attached to a customer
//             if (paymentMethod.customer) {
//               console.log(
//                 `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethod.customer}`
//               );

//               // Use that customer
//               customer = await stripe.customers.retrieve(
//                 paymentMethod.customer
//               );
//               console.log(`Using existing customer ${customer.id}`);
//             } else {
//               // If it's not attached to any customer, create a new one
//               customer = await stripe.customers.create({
//                 email: donorDetails.email,
//                 name: donorDetails.name,
//                 phone: donorDetails.phone,
//               });

//               console.log(`Created new customer ${customer.id}`);

//               // Then attach the payment method to the customer
//               await stripe.paymentMethods.attach(stripePaymentMethodId, {
//                 customer: customer.id,
//               });

//               console.log(
//                 `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
//               );
//             }

//             // Set it as the default payment method
//             await stripe.customers.update(customer.id, {
//               invoice_settings: {
//                 default_payment_method: stripePaymentMethodId,
//               },
//             });

//             console.log(
//               `Set payment method ${stripePaymentMethodId} as default for customer ${customer.id}`
//             );
//           } catch (stripeError) {
//             console.error("Error handling payment method:", stripeError);

//             // Special handling for the "already attached" error
//             if (
//               stripeError.code === "payment_method_in_use" ||
//               stripeError.message.includes("already been attached")
//             ) {
//               try {
//                 console.log("Handling 'already attached' error");

//                 // Try to find the customer by looking up the payment method
//                 const paymentMethod = await stripe.paymentMethods.retrieve(
//                   stripePaymentMethodId
//                 );

//                 if (paymentMethod.customer) {
//                   // Use the customer this payment method is already attached to
//                   customer = await stripe.customers.retrieve(
//                     paymentMethod.customer
//                   );
//                   console.log(
//                     `Using existing customer ${customer.id} that payment method is attached to`
//                   );
//                 } else {
//                   // This shouldn't happen if we got an "already attached" error, but just in case
//                   throw new Error(
//                     "Payment method is reported as already attached but no customer found"
//                   );
//                 }
//               } catch (secondError) {
//                 console.error("Error in special handling:", secondError);
//                 throw secondError;
//               }
//             } else {
//               // For other types of errors, just pass them along
//               throw stripeError;
//             }
//           }

//           // Convert frequency to Stripe interval
//           let interval;
//           switch (recurringDetails.frequency) {
//             case "daily": // Note: Stripe doesn't support daily, you might need a custom solution
//               interval = "day";
//               break;
//             case "weekly":
//               interval = "week";
//               break;
//             case "monthly":
//               interval = "month";
//               break;
//             case "yearly":
//               interval = "year";
//               break;
//             default:
//               interval = "month";
//           }

//           // First create the product
//           const product = await stripe.products.create({
//             name: "Recurring Donation",
//             metadata: {
//               donationId: savedOrder.donationId,
//             },
//           });

//           console.log(`Created product for recurring donation: ${product.id}`);

//           // Create the subscription with the product ID - MODIFIED to ensure immediate completion
//           const subscription = await stripe.subscriptions.create({
//             customer: customer.id,
//             items: [
//               {
//                 price_data: {
//                   currency: "aud",
//                   product: product.id,
//                   unit_amount: Math.round(recurringDetails.amount * 100),
//                   recurring: {
//                     interval: interval,
//                   },
//                 },
//               },
//             ],
//             // Removed payment_behavior: "default_incomplete"
//             payment_settings: {
//               save_default_payment_method: "on_subscription",
//               payment_method_types: ["card"],
//             },
//             default_payment_method: stripePaymentMethodId, // Explicitly set default payment method
//             expand: ["latest_invoice.payment_intent"],
//           });

//           console.log(
//             `Created subscription: ${subscription.id} for customer ${customer.id}, status: ${subscription.status}`
//           );

//           // Update order with subscription details
//           savedOrder.transactionDetails = {
//             stripeCustomerId: customer.id,
//             stripeSubscriptionId: subscription.id,
//             stripeStatus: subscription.status,
//             clientSecret:
//               subscription.latest_invoice.payment_intent?.client_secret,
//           };

//           // Set payment status based on subscription status
//           if (subscription.status === "active") {
//             savedOrder.paymentStatus = "completed";
//             // Send receipt email for completed payments
//             try {
//               await sendReceiptEmail(savedOrder);
//             } catch (emailError) {
//               console.error("Failed to send receipt email:", emailError);
//               // Don't fail the order if email fails
//             }
//           } else if (subscription.status === "incomplete") {
//             savedOrder.paymentStatus = "requires_action";
//           }

//           await savedOrder.save();
//         } else if (paymentType === "installments") {
//           // IMPROVED PAYMENT METHOD HANDLING
//           let customer;

//           try {
//             // First, try to retrieve the payment method
//             const paymentMethod = await stripe.paymentMethods.retrieve(
//               stripePaymentMethodId
//             );

//             // If it's already attached to a customer
//             if (paymentMethod.customer) {
//               console.log(
//                 `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethod.customer}`
//               );

//               // Use that customer
//               customer = await stripe.customers.retrieve(
//                 paymentMethod.customer
//               );
//               console.log(`Using existing customer ${customer.id}`);
//             } else {
//               // If it's not attached to any customer, create a new one
//               customer = await stripe.customers.create({
//                 email: donorDetails.email,
//                 name: donorDetails.name,
//                 phone: donorDetails.phone,
//               });

//               console.log(`Created new customer ${customer.id}`);

//               // Then attach the payment method to the customer
//               await stripe.paymentMethods.attach(stripePaymentMethodId, {
//                 customer: customer.id,
//               });

//               console.log(
//                 `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
//               );
//             }

//             // Set it as the default payment method
//             await stripe.customers.update(customer.id, {
//               invoice_settings: {
//                 default_payment_method: stripePaymentMethodId,
//               },
//             });

//             console.log(
//               `Set payment method ${stripePaymentMethodId} as default for customer ${customer.id}`
//             );
//           } catch (stripeError) {
//             console.error("Error handling payment method:", stripeError);

//             // Special handling for the "already attached" error
//             if (
//               stripeError.code === "payment_method_in_use" ||
//               stripeError.message.includes("already been attached")
//             ) {
//               try {
//                 console.log("Handling 'already attached' error");

//                 // Try to find the customer by looking up the payment method
//                 const paymentMethod = await stripe.paymentMethods.retrieve(
//                   stripePaymentMethodId
//                 );

//                 if (paymentMethod.customer) {
//                   // Use the customer this payment method is already attached to
//                   customer = await stripe.customers.retrieve(
//                     paymentMethod.customer
//                   );
//                   console.log(
//                     `Using existing customer ${customer.id} that payment method is attached to`
//                   );
//                 } else {
//                   // This shouldn't happen if we got an "already attached" error, but just in case
//                   throw new Error(
//                     "Payment method is reported as already attached but no customer found"
//                   );
//                 }
//               } catch (secondError) {
//                 console.error("Error in special handling:", secondError);
//                 throw secondError;
//               }
//             } else {
//               // For other types of errors, just pass them along
//               throw stripeError;
//             }
//           }

//           // Process first installment - MODIFIED to match recurring improvement approach
//           const paymentIntent = await stripe.paymentIntents.create({
//             amount: Math.round(installmentDetails.installmentAmount * 100),
//             currency: "aud",
//             customer: customer.id,
//             payment_method: stripePaymentMethodId,
//             automatic_payment_methods: {
//               enabled: true,
//               allow_redirects: "never",
//             },
//             confirm: true,
//             off_session: true, // Added to attempt immediate processing
//             description: `Installment 1/${installmentDetails.numberOfInstallments} for Donation ${savedOrder.donationId}`,
//             metadata: {
//               donationId: savedOrder.donationId,
//               orderId: savedOrder._id.toString(),
//               installment: 1,
//               totalInstallments: installmentDetails.numberOfInstallments,
//             },
//           });

//           console.log(`Created first installment payment: ${paymentIntent.id}`);

//           // Store customer ID for future installments
//           savedOrder.transactionDetails = {
//             stripeCustomerId: customer.id,
//             stripePaymentIntentId: paymentIntent.id,
//             stripeStatus: paymentIntent.status,
//             clientSecret: paymentIntent.client_secret,
//           };

//           // Update installment details
//           if (savedOrder.installmentDetails) {
//             savedOrder.installmentDetails.installmentsPaid = 1;

//             // Calculate next installment date (30 days from now)
//             const paymentIntervalDays = 30; // Monthly interval
//             savedOrder.installmentDetails.nextInstallmentDate = new Date(
//               Date.now() + paymentIntervalDays * 24 * 60 * 60 * 1000
//             );

//             // Add to payment history
//             savedOrder.installmentDetails.installmentHistory.push({
//               installmentNumber: 1,
//               amount: installmentDetails.installmentAmount,
//               date: new Date(),
//               status:
//                 paymentIntent.status === "succeeded"
//                   ? "completed"
//                   : "processing",
//               transactionId: paymentIntent.id,
//             });
//           }

//           // Set payment status
//           if (paymentIntent.status === "succeeded") {
//             // Send receipt email for completed payments
//             try {
//               await sendReceiptEmail(savedOrder);
//             } catch (emailError) {
//               console.error("Failed to send receipt email:", emailError);
//               // Don't fail the order if email fails
//             }
//             // For installments, we keep the order in "processing" until all installments are paid
//             savedOrder.paymentStatus = "processing";
//           } else if (paymentIntent.status === "requires_action") {
//             savedOrder.paymentStatus = "requires_action";
//           }

//           await savedOrder.save();
//         }
//       } catch (stripeError) {
//         console.error("Stripe payment error:", stripeError);

//         // Update order status to failed
//         savedOrder.paymentStatus = "failed";
//         savedOrder.transactionDetails = {
//           error: stripeError.message,
//         };
//         await savedOrder.save();

//         return res.status(400).json({
//           status: "Error",
//           message: `Payment processing failed: ${stripeError.message}`,
//           order: {
//             _id: savedOrder._id,
//             donationId: savedOrder.donationId,
//           },
//         });
//       }
//     }

//     if (paymentMethod === "bank") {
//       try {
//         await sendReceiptEmail(savedOrder);
//         console.log(
//           `Bank transfer receipt sent for order: ${savedOrder.donationId}`
//         );
//       } catch (emailError) {
//         console.error(
//           "Failed to send bank transfer receipt email:",
//           emailError
//         );
//         // Don't fail the order if email fails
//       }
//     }

//     // Send response
//     res.status(201).json({
//       status: "Success",
//       message: "Order created successfully",
//       order: {
//         _id: savedOrder._id,
//         donationId: savedOrder.donationId,
//         totalAmount: savedOrder.totalAmount,
//         paymentStatus: savedOrder.paymentStatus,
//         recurringDetails: orderRecurringDetails,
//         installmentDetails: orderInstallmentDetails,
//         transactionDetails: savedOrder.transactionDetails,
//         paymentInstructions:
//           paymentMethod === "bank"
//             ? {
//                 bankName: "Westpac",
//                 bsb: "032075",
//                 accountNumber: "841783",
//                 reference: savedOrder.donationId,
//               }
//             : null,
//       },
//     });
//   } catch (error) {
//     console.error("Order creation error:", error);
//     res.status(500).json({
//       status: "Error",
//       message: "Failed to create order",
//       error: error.message,
//     });
//   }
// };


exports.createOrder = async (req, res) => {
  try {
    const {
      items,
      paymentType,
      adminCostContribution,
      donorDetails,
      paymentMethod, // "visa", "mastercard", or "bank"
      totalAmount,
      recurringDetails,
      installmentDetails,
      stripePaymentMethodId,
      updateUserDetails,
      donationType,
    } = req.body;

    console.log("Received order data:", req.body);

    // Validate required fields
    if (!items || !paymentType || !donorDetails) {
      return res.status(400).json({
        status: "Error",
        message: "Missing required fields",
      });
    }

    // Get user from request (populated by auth middleware)
    const user = req.user;

    // Update user details if needed
    if (user && (updateUserDetails || donorDetails.rememberDetails)) {
      try {
        const userUpdates = {
          name: donorDetails.name,
          phone: donorDetails.phone,
          address: {
            street: donorDetails.streetAddress,
            city: donorDetails.townCity,
            state: donorDetails.state,
            postcode: donorDetails.postcode,
          },
        };
        await User.findByIdAndUpdate(user._id, userUpdates);
        console.log(`Updated user details for user ${user._id}`);
      } catch (userUpdateError) {
        console.error("Error updating user details:", userUpdateError);
        // Don't fail the order if user update fails
      }
    }

    // Generate unique donation ID with user info
    const donationId = await generateUniqueDonationId(async (id) => {
      const existingOrder = await Order.findOne({ donationId: id });
      return !!existingOrder;
    }, user);

    // Validate recurring payment details if applicable
    if (paymentType === "recurring") {
      if (
        !recurringDetails ||
        !recurringDetails.frequency ||
        !recurringDetails.amount
      ) {
        return res.status(400).json({
          status: "Error",
          message: "Recurring payment requires frequency and amount",
        });
      }
      const validFrequencies = ["daily", "weekly", "monthly", "yearly"];
      if (!validFrequencies.includes(recurringDetails.frequency)) {
        return res.status(400).json({
          status: "Error",
          message: "Invalid frequency for recurring payment",
        });
      }
    }

    // Validate installment payment details if applicable
    if (paymentType === "installments") {
      if (
        !installmentDetails ||
        !installmentDetails.numberOfInstallments ||
        !installmentDetails.installmentAmount
      ) {
        return res.status(400).json({
          status: "Error",
          message:
            "Installment payment requires numberOfInstallments and installmentAmount",
        });
      }
      if (
        installmentDetails.numberOfInstallments < 1 ||
        installmentDetails.numberOfInstallments > 12
      ) {
        return res.status(400).json({
          status: "Error",
          message: "Number of installments must be between 1 and 12",
        });
      }
    }

    // Update donor details if needed
    if (donorDetails.rememberDetails && user) {
      await User.findByIdAndUpdate(user._id, {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
        address: {
          street: donorDetails.streetAddress,
          city: donorDetails.townCity,
          state: donorDetails.state,
          postcode: donorDetails.postcode,
        },
      });
    }

    // Process items array
    const processedItems = items.map((item) => ({
      title: item.title,
      price: item.price,
      quantity: item.quantity || 1,
      onBehalfOf: item.onBehalfOf || null,
    }));

    // Build recurring details only if paymentType is "recurring"
    let orderRecurringDetails;
    if (paymentType === "recurring") {
      orderRecurringDetails = {
        frequency: recurringDetails.frequency,
        amount: recurringDetails.amount,
        startDate: new Date(),
        endDate: recurringDetails.endDate
          ? new Date(recurringDetails.endDate)
          : null, // include end date if provided
        status: "active",
        nextPaymentDate: calculateNextPaymentDate(
          new Date(),
          recurringDetails.frequency
        ),
        totalPayments: 0,
        paymentHistory: [],
      };
    }

    // Build installment details only if paymentType is "installments"
    let orderInstallmentDetails;
    if (paymentType === "installments") {
      const paymentIntervalDays = 30;
      orderInstallmentDetails = {
        numberOfInstallments: installmentDetails.numberOfInstallments,
        installmentAmount: installmentDetails.installmentAmount,
        startDate: new Date(),
        status: "active",
        installmentsPaid: 0,
        nextInstallmentDate: new Date(),
        installmentHistory: [],
        paymentIntervalDays: paymentIntervalDays,
      };
    }

    // Build the order object conditionally.
    // Note: If paymentType is not "recurring" or "installments", we explicitly set those keys to undefined.
    const orderObj = {
      user: user ? user._id : null,
      donationId,
      items: processedItems,
      paymentType,
      adminCostContribution: {
        included: !!adminCostContribution,
        amount: adminCostContribution || 0,
      },
      donorDetails: {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
        address: {
          street: donorDetails.streetAddress,
          city: donorDetails.townCity,
          state: donorDetails.state,
          postcode: donorDetails.postcode,
        },
        agreeToMessages: donorDetails.agreeToMessages,
      },
      donationType: req.body.donationType,
      paymentMethod,
      paymentStatus: paymentMethod === "bank" ? "pending" : "processing",
      totalAmount,
      transactionDetails: {},
      recurringDetails: paymentType === "recurring" ? orderRecurringDetails : undefined,
      installmentDetails:
        paymentType === "installments" ? orderInstallmentDetails : undefined,
    };

    // Create the order using the conditionally built object
    const order = new Order(orderObj);

    // Save order with a retry mechanism in case of donationId collision
    let savedOrder = null;
    let retries = 3;
    while (retries > 0) {
      try {
        savedOrder = await order.save();
        break;
      } catch (error) {
        if (
          error.code === 11000 &&
          error.keyPattern &&
          error.keyPattern.donationId
        ) {
          order.donationId = `D${Date.now()}${Math.floor(
            Math.random() * 10000
          )
            .toString()
            .padStart(4, "0")}`;
          retries--;
        } else {
          throw error;
        }
      }
    }

    if (!savedOrder) {
      throw new Error(
        "Failed to generate unique donation ID after multiple attempts"
      );
    }

    console.log("Order saved:", savedOrder);

    // If no user exists and donor email is provided, create a new user for the donor
    if (!user && donorDetails.email) {
      try {
        const newUser = await createUserForDonor(
          donorDetails,
          savedOrder.donationId
        );
        if (newUser) {
          savedOrder.user = newUser._id;
          await savedOrder.save();
          console.log(
            `Linked order ${savedOrder._id} to new user ${newUser._id}`
          );
        }
      } catch (userCreateError) {
        console.error("Failed to create user account for donor:", userCreateError);
      }
    }

    // Process payment with Stripe if a card is selected (visa or mastercard)
    if (
      (paymentMethod === "visa" || paymentMethod === "mastercard") &&
      stripePaymentMethodId
    ) {
      try {
        if (paymentType === "single") {
          // Process one-time payment
          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(totalAmount * 100),
            currency: "aud",
            payment_method: stripePaymentMethodId,
            confirm: true,
            off_session: true,
            description: `Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
            },
          });

          savedOrder.transactionDetails = {
            stripePaymentMethodId,
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
            clientSecret: paymentIntent.client_secret,
          };

          if (paymentIntent.status === "succeeded") {
            try {
              await sendReceiptEmail(savedOrder);
            } catch (emailError) {
              console.error("Failed to send receipt email:", emailError);
            }
            savedOrder.paymentStatus = "completed";
          } else if (paymentIntent.status === "failed") {
            savedOrder.paymentStatus = "failed";
          }

          await savedOrder.save();
        }  else if (paymentType === "recurring") {
          // Recurring payment processing
          let customer;
          try {
            const paymentMethodObj = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );
            if (paymentMethodObj.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethodObj.customer}`
              );
              customer = await stripe.customers.retrieve(paymentMethodObj.customer);
              console.log(`Using existing customer ${customer.id}`);
            } else {
              customer = await stripe.customers.create({
                email: donorDetails.email,
                name: donorDetails.name,
                phone: donorDetails.phone,
              });
              console.log(`Created new customer ${customer.id}`);
              await stripe.paymentMethods.attach(stripePaymentMethodId, {
                customer: customer.id,
              });
              console.log(
                `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
              );
            }
        
            await stripe.customers.update(customer.id, {
              invoice_settings: { default_payment_method: stripePaymentMethodId },
            });
            console.log(
              `Set payment method ${stripePaymentMethodId} as default for customer ${customer.id}`
            );
          } catch (stripeError) {
            console.error("Error handling payment method:", stripeError);
            if (
              stripeError.code === "payment_method_in_use" ||
              stripeError.message.includes("already been attached")
            ) {
              try {
                console.log("Handling 'already attached' error");
                const paymentMethodObj = await stripe.paymentMethods.retrieve(
                  stripePaymentMethodId
                );
                if (paymentMethodObj.customer) {
                  customer = await stripe.customers.retrieve(
                    paymentMethodObj.customer
                  );
                  console.log(
                    `Using existing customer ${customer.id} that payment method is attached to`
                  );
                } else {
                  throw new Error(
                    "Payment method is reported as already attached but no customer found"
                  );
                }
              } catch (secondError) {
                console.error("Error in special handling:", secondError);
                throw secondError;
              }
            } else {
              throw stripeError;
            }
          }
        
          let interval;
          switch (recurringDetails.frequency) {
            case "daily":
              interval = "day";
              break;
            case "weekly":
              interval = "week";
              break;
            case "monthly":
              interval = "month";
              break;
            case "yearly":
              interval = "year";
              break;
            default:
              interval = "month";
          }
        
          const product = await stripe.products.create({
            name: "Recurring Donation",
            metadata: { donationId: savedOrder.donationId },
          });
          console.log(`Created product for recurring donation: ${product.id}`);
        
          // Build the subscription data object
          let subscriptionData = {
            customer: customer.id,
            items: [
              {
                price_data: {
                  currency: "aud",
                  product: product.id,
                  unit_amount: Math.round(recurringDetails.amount * 100),
                  recurring: { interval: interval },
                },
              },
            ],
            payment_settings: {
              save_default_payment_method: "on_subscription",
              payment_method_types: ["card"],
            },
            default_payment_method: stripePaymentMethodId,
            expand: ["latest_invoice.payment_intent"],
          };
        
          if (recurringDetails.endDate) {
            const cancelAtTimestamp = Math.floor(
              new Date(recurringDetails.endDate).getTime() / 1000
            );
            subscriptionData.cancel_at = cancelAtTimestamp;
            console.log(`Subscription will cancel at ${recurringDetails.endDate}`);
          }
        
          const subscription = await stripe.subscriptions.create(subscriptionData);
          console.log(
            `Created subscription: ${subscription.id} for customer ${customer.id}, status: ${subscription.status}`
          );
        
          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripeSubscriptionId: subscription.id,
            stripeStatus: subscription.status,
            clientSecret: subscription.latest_invoice.payment_intent?.client_secret,
          };
        
          if (subscription.status === "active") {
            savedOrder.paymentStatus = "completed";
            try {
              await sendReceiptEmail(savedOrder);
            } catch (emailError) {
              console.error("Failed to send receipt email:", emailError);
            }
          } else {
            // For any non-active subscription (e.g. pending/incomplete), leave the status as pending.
            savedOrder.paymentStatus = "pending";
          }
        
          await savedOrder.save();
        }
        else if (paymentType === "installments") {
          // Installment processing
          let customer;
          try {
            const paymentMethodObj = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );
            if (paymentMethodObj.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethodObj.customer}`
              );
              customer = await stripe.customers.retrieve(paymentMethodObj.customer);
              console.log(`Using existing customer ${customer.id}`);
            } else {
              customer = await stripe.customers.create({
                email: donorDetails.email,
                name: donorDetails.name,
                phone: donorDetails.phone,
              });
              console.log(`Created new customer ${customer.id}`);
              await stripe.paymentMethods.attach(stripePaymentMethodId, {
                customer: customer.id,
              });
              console.log(
                `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
              );
            }

            await stripe.customers.update(customer.id, {
              invoice_settings: { default_payment_method: stripePaymentMethodId },
            });
            console.log(
              `Set payment method ${stripePaymentMethodId} as default for customer ${customer.id}`
            );
          } catch (stripeError) {
            console.error("Error handling payment method:", stripeError);
            if (
              stripeError.code === "payment_method_in_use" ||
              stripeError.message.includes("already been attached")
            ) {
              try {
                console.log("Handling 'already attached' error");
                const paymentMethodObj = await stripe.paymentMethods.retrieve(
                  stripePaymentMethodId
                );
                if (paymentMethodObj.customer) {
                  customer = await stripe.customers.retrieve(
                    paymentMethodObj.customer
                  );
                  console.log(
                    `Using existing customer ${customer.id} that payment method is attached to`
                  );
                } else {
                  throw new Error(
                    "Payment method is reported as already attached but no customer found"
                  );
                }
              } catch (secondError) {
                console.error("Error in special handling:", secondError);
                throw secondError;
              }
            } else {
              throw stripeError;
            }
          }

          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(installmentDetails.installmentAmount * 100),
            currency: "aud",
            customer: customer.id,
            payment_method: stripePaymentMethodId,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: "never",
            },
            confirm: true,
            off_session: true,
            description: `Installment 1/${installmentDetails.numberOfInstallments} for Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
              installment: 1,
              totalInstallments: installmentDetails.numberOfInstallments,
            },
          });

          console.log(`Created first installment payment: ${paymentIntent.id}`);

          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
            clientSecret: paymentIntent.client_secret,
          };

          if (savedOrder.installmentDetails) {
            savedOrder.installmentDetails.installmentsPaid = 1;
            const paymentIntervalDays = 30;
            savedOrder.installmentDetails.nextInstallmentDate = new Date(
              Date.now() + paymentIntervalDays * 24 * 60 * 60 * 1000
            );
            savedOrder.installmentDetails.installmentHistory.push({
              installmentNumber: 1,
              amount: installmentDetails.installmentAmount,
              date: new Date(),
              status:
                paymentIntent.status === "succeeded" ? "completed" : "processing",
              transactionId: paymentIntent.id,
            });
          }

          if (paymentIntent.status === "succeeded") {
            try {
              await sendReceiptEmail(savedOrder);
            } catch (emailError) {
              console.error("Failed to send receipt email:", emailError);
            }
            savedOrder.paymentStatus = "processing";
          } else if (paymentIntent.status === "requires_action") {
            savedOrder.paymentStatus = "failed";
          }

          await savedOrder.save();
        }
      } catch (stripeError) {
        console.error("Stripe payment error:", stripeError);
        savedOrder.paymentStatus = "failed";
        savedOrder.transactionDetails = { error: stripeError.message };
        await savedOrder.save();

        return res.status(400).json({
          status: "Error",
          message: `Payment processing failed: ${stripeError.message}`,
          order: { _id: savedOrder._id, donationId: savedOrder.donationId },
        });
      }
    }

    if (paymentMethod === "bank") {
      if (savedOrder.paymentStatus === "completed") {
        try {
          await sendReceiptEmail(savedOrder);
          console.log(
            `Bank transfer receipt sent for order: ${savedOrder.donationId}`
          );
        } catch (emailError) {
          console.error("Failed to send bank transfer receipt email:", emailError);
        }
      } else {
        console.log(
          `Order ${savedOrder.donationId} is still pending; receipt not sent.`
        );
      }
    }

    res.status(201).json({
      status: "Success",
      message: "Order created successfully",
      order: {
        _id: savedOrder._id,
        donationId: savedOrder.donationId,
        totalAmount: savedOrder.totalAmount,
        paymentStatus: savedOrder.paymentStatus,
        recurringDetails: paymentType === "recurring" ? orderRecurringDetails : undefined,
        installmentDetails:
          paymentType === "installments" ? orderInstallmentDetails : undefined,
        transactionDetails: savedOrder.transactionDetails,
        paymentInstructions:
          paymentMethod === "bank"
            ? {
                bankName: "Westpac",
                bsb: "032075",
                accountNumber: "841783",
                reference: savedOrder.donationId,
              }
            : null,
      },
    });
  } catch (error) {
    console.error("Order creation error:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to create order",
      error: error.message,
    });
  }
};



exports.getOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select("-__v");

    res.json({
      status: "Success",
      orders,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).select("-__v");

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    // Check if user has access to this order
    if (order.user && order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: "Error",
        message: "Not authorized to view this order",
      });
    }

    res.json({
      status: "Success",
      order,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch order",
      error: error.message,
    });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { paymentStatus, transactionDetails } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    order.paymentStatus = paymentStatus;
    if (transactionDetails) {
      order.transactionDetails = transactionDetails;
    }

    await order.save();

    // Create log entry
    await createLog("UPDATE", "ORDER", order._id, req.user, req, {
      paymentStatus,
    });

    res.json({
      status: "Success",
      message: "Order status updated",
      order,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

exports.getOrderStats = async (req, res) => {
  try {
    const userId = req.user._id;

    console.log("Getting order stats for user:", req.user);

    // Get all orders for the user
    const orders = await Order.find({ user: userId });

    // Calculate total donated amount
    const totalDonated = orders.reduce(
      (sum, order) => sum + order.totalAmount,
      0
    );

    // Calculate recurring donations
    const recurringOrders = orders.filter(
      (order) =>
        order.paymentType === "recurring" ||
        order.paymentType === "installments"
    );

    // Calculate active recurring (not failed or completed)
    const activeRecurring = recurringOrders.filter(
      (order) =>
        order.paymentStatus !== "failed" && order.paymentStatus !== "completed"
    ).length;

    // Count one-time donations
    const oneTimeOrders = orders.filter(
      (order) => order.paymentType === "single"
    );

    const stats = {
      totalDonated,
      activeRecurring,
      recurringCount: recurringOrders.length,
      oneTimeCount: oneTimeOrders.length,
      totalOrders: orders.length,
      // Additional stats
      completedOrders: orders.filter(
        (order) => order.paymentStatus === "completed"
      ).length,
      pendingOrders: orders.filter((order) => order.paymentStatus === "pending")
        .length,
      failedOrders: orders.filter((order) => order.paymentStatus === "failed")
        .length,
      // Monthly stats
      monthlyStats: getMonthlyStats(orders),
    };

    res.json({
      status: "Success",
      stats,
    });
  } catch (error) {
    console.error("Error getting order stats:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to get order statistics",
      error: error.message,
    });
  }
};

// Helper function to calculate monthly stats
const getMonthlyStats = (orders) => {
  const monthlyData = {};

  orders.forEach((order) => {
    const date = new Date(order.createdAt);
    const monthYear = `${date.getFullYear()}-${String(
      date.getMonth() + 1
    ).padStart(2, "0")}`;

    if (!monthlyData[monthYear]) {
      monthlyData[monthYear] = {
        total: 0,
        count: 0,
        recurring: 0,
        oneTime: 0,
      };
    }

    monthlyData[monthYear].total += order.totalAmount;
    monthlyData[monthYear].count += 1;

    if (order.paymentType === "single") {
      monthlyData[monthYear].oneTime += 1;
    } else {
      monthlyData[monthYear].recurring += 1;
    }
  });

  // Convert to array and sort by date
  return Object.entries(monthlyData)
    .map(([month, data]) => ({
      month,
      ...data,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
};

// Helper function to calculate next payment date
const calculateNextPaymentDate = (startDate, frequency) => {
  const nextDate = new Date(startDate);
  switch (frequency) {
    case "daily":
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case "weekly":
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case "monthly":
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case "yearly":
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      break;
    default:
      nextDate.setMonth(nextDate.getMonth() + 1);
  }
  return nextDate;
};

/**
 * Process the next installment payment for an order
 * @param {string} orderId - The order ID to process the next installment for
 */
exports.processNextInstallment = async (orderId) => {
  try {
    const order = await Order.findById(orderId);

    if (!order) {
      console.error(`Order not found: ${orderId}`);
      return;
    }

    // Ensure this is an active installment order with remaining installments.
    if (
      order.paymentType !== "installments" ||
      !order.installmentDetails ||
      order.installmentDetails.status !== "active" ||
      order.installmentDetails.installmentsPaid >= order.installmentDetails.numberOfInstallments
    ) {
      console.log(`No installment to process for order: ${orderId}`);
      return;
    }

    // Check if it's time to process the next installment.
    const now = new Date();
    const nextDate = new Date(order.installmentDetails.nextInstallmentDate);
    if (now < nextDate) {
      console.log(`Not yet time for next installment for order: ${orderId}`);
      return;
    }

    const installmentNumber = order.installmentDetails.installmentsPaid + 1;
    console.log(
      `Processing installment ${installmentNumber}/${order.installmentDetails.numberOfInstallments} for order: ${orderId}`
    );

    // Process payment with Stripe.
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(order.installmentDetails.installmentAmount * 100),
      currency: "aud",
      customer: order.transactionDetails.stripeCustomerId,
      payment_method: order.transactionDetails.stripePaymentMethodId, // ensure this is stored from the initial installment processing
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      confirm: true,
      off_session: true,
      description: `Installment ${installmentNumber}/${order.installmentDetails.numberOfInstallments} for Donation ${order.donationId}`,
      metadata: {
        donationId: order.donationId,
        orderId: order._id.toString(),
        installment: installmentNumber,
        totalInstallments: order.installmentDetails.numberOfInstallments,
      },
    });

    // Update order with payment result.
    order.installmentDetails.installmentsPaid = installmentNumber;

    // Calculate and store the next installment date if there are more installments remaining.
    if (installmentNumber < order.installmentDetails.numberOfInstallments) {
      order.installmentDetails.nextInstallmentDate = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      );
    } else {
      // Final installment: mark order as completed.
      order.installmentDetails.status = "completed";
      order.paymentStatus = "completed";
    }

    // Record this installment in the history.
    order.installmentDetails.installmentHistory.push({
      installmentNumber: installmentNumber,
      amount: order.installmentDetails.installmentAmount,
      date: new Date(),
      status: paymentIntent.status === "succeeded" ? "completed" : "processing",
      transactionId: paymentIntent.id,
    });

    await order.save();

    console.log(
      `Successfully processed installment ${installmentNumber} for order: ${orderId}`
    );

    // Send receipt email for the completed installment.
    try {
      const { sendReceiptEmail } = require("../services/recieptUtils");
      await sendReceiptEmail(order, installmentNumber);
    } catch (emailError) {
      console.error("Failed to send receipt email:", emailError);
      // Do not fail the order update if email sending fails.
    }

    return { success: true, paymentIntent };
  } catch (error) {
    console.error(`Error processing installment for order ${orderId}:`, error);

    // On error, update the order with error information without incrementing installmentsPaid.
    try {
      const order = await Order.findById(orderId);
      if (order && order.installmentDetails) {
        order.installmentDetails.installmentHistory.push({
          installmentNumber: order.installmentDetails.installmentsPaid + 1,
          amount: order.installmentDetails.installmentAmount,
          date: new Date(),
          status: "failed",
          error: error.message,
        });
        // Schedule a retry in 24 hours.
        order.installmentDetails.nextInstallmentDate = new Date(
          Date.now() + 24 * 60 * 60 * 1000
        );
        await order.save();
      }
    } catch (updateError) {
      console.error(
        "Failed to update order with error information:",
        updateError
      );
    }

    return { success: false, error: error.message };
  }
};


exports.uploadReceipt = [
  upload.single("receipt"), // "receipt" must match the FormData key from the frontend
  async (req, res) => {
    try {
      const { donationId, userId } = req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded",
        });
      }

      // multer-s3 automatically adds a "location" property with the S3 file URL
      const fileUrl = req.file.location;

      // Find the order in your database by donationId
      const order = await Order.findOne({ donationId });
      if (!order) {
        return res.status(404).json({
          success: false,
          message: `Order not found for donationId: ${donationId}`,
        });
      }

      // Store the file URL in your order document along with metadata
      order.receiptUrl = fileUrl;
      order.receiptUploadedAt = new Date();
      if (userId) {
        order.receiptUploadedBy = userId;
      }
      await order.save();

      // Return a receipt object so the frontend receives complete data
      return res.json({
        success: true,
        message: "Receipt uploaded successfully",
        receipt: {
          fileUrl,
          fileName: path.basename(fileUrl),
          uploadDate: order.receiptUploadedAt,
        },
      });
    } catch (error) {
      console.error("Error uploading receipt:", error);
      return res.status(500).json({
        success: false,
        message: "Server error uploading receipt",
        error: error.message,
      });
    }
  },
];

// Get Order By Donation ID Controller
exports.getOrderByDonationId = async (req, res) => {
  try {
    const { donationId } = req.params;
    const order = await Order.findOne({ donationId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order not found for donationId: ${donationId}`,
      });
    }
    return res.json({
      success: true,
      order,
    });
  } catch (error) {
    console.error("Error fetching order by donationId:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching order",
      error: error.message,
    });
  }
};

// Delete Receipt Controller
exports.deleteReceipt = async (req, res) => {
  try {
    const { donationId } = req.params;
    const order = await Order.findOne({ donationId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order not found for donationId: ${donationId}`,
      });
    }
    if (!order.receiptUrl) {
      return res.status(400).json({
        success: false,
        message: "No receipt to delete.",
      });
    }

    // Only clear receipt info in the order document (do not delete from S3)
    order.receiptUrl = undefined;
    order.receiptUploadedAt = undefined;
    order.receiptUploadedBy = undefined;
    await order.save();

    return res.json({
      success: true,
      message: "Receipt deleted from database successfully",
    });
  } catch (error) {
    console.error("Error deleting receipt:", error);
    return res.status(500).json({
      success: false,
      message: "Server error deleting receipt",
      error: error.message,
    });
  }
};


exports.proxyReceiptForViewing = async (req, res) => {
  try {
    const { donationId } = req.params;
    
    // Find the order in your database
    const order = await Order.findOne({ donationId });
    if (!order || !order.receiptUrl) {
      return res.status(404).json({
        success: false,
        message: "Receipt not found",
      });
    }
    
    const receiptUrl = order.receiptUrl;
    
    try {
      // Fetch the file from S3
      const response = await axios.get(receiptUrl, {
        responseType: 'arraybuffer'
      });
      
      // Determine content type based on the file name
      const fileName = receiptUrl.split('/').pop();
      const fileExt = path.extname(fileName).replace('.', '').toLowerCase();
      
      const contentTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'pdf': 'application/pdf',
      };
      
      const contentType = contentTypes[fileExt] || 'application/octet-stream';
      
      // Set headers for inline display
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
      
      // Send the file
      return res.send(response.data);
    } catch (error) {
      console.error("Error fetching receipt from S3:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching receipt from storage",
      });
    }
  } catch (error) {
    console.error("Error proxying receipt for viewing:", error);
    return res.status(500).json({
      success: false,
      message: "Server error proxying receipt",
      error: error.message,
    });
  }
};