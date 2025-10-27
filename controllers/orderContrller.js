// controllers/orderController.js
const Order = require("../models/order");
const User = require("../models/user");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { sendReceiptEmail, generateStatementPDF } = require("../services/recieptUtils");
const { sendEmail } = require("../services/emailUtil");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { upload } = require("../config/s3");
const path = require("path");
const axios = require("axios");
const GoFundMeDonation = require("../models/goFundMeDonations");

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
      isTemporaryPassword: true, // Mark as temporary password that needs to be changed on first login
    });

    // Save the user
    await newUser.save();
    console.log(`Created new user account for donor: ${donorDetails.email}`);

    // Send welcome email with credentials
    const loginUrl = "https://shahidafridifoundation.org.au/login";

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

// const calculateBillingAnchor = (billingDay) => {
//   const today = new Date();
//   // Normalize billing day to valid range for month
//   const currentMonth = today.getMonth();
//   const currentYear = today.getFullYear();
//   const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
//   const normalizedBillingDay = Math.min(billingDay, daysInMonth);

//   // Create date for this month's billing day
//   let billingDate = new Date(currentYear, currentMonth, normalizedBillingDay);

//   // If the billing day has already passed this month, move to next month
//   if (today > billingDate) {
//     billingDate.setMonth(billingDate.getMonth() + 1);
//     // Adjust for different month lengths
//     const nextMonthDays = new Date(
//       billingDate.getFullYear(),
//       billingDate.getMonth() + 1,
//       0
//     ).getDate();
//     billingDate.setDate(Math.min(normalizedBillingDay, nextMonthDays));
//   }

//   return Math.floor(billingDate.getTime() / 1000);
// };
const calculateBillingAnchor = (billingDay) => {
  const today = new Date();

  // For same-day billing, charge immediately (no billing anchor needed)
  if (today.getDate() === billingDay) {
    console.log(
      "Same day billing - no billing anchor needed, charging immediately"
    );
    return null; // Don't set billing anchor for immediate charging
  }

  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const normalizedBillingDay = Math.min(billingDay, daysInMonth);

  // Create date for this month's billing day
  let billingDate = new Date(currentYear, currentMonth, normalizedBillingDay);

  // If the billing day has already passed this month, move to next month
  if (today.getDate() > normalizedBillingDay) {
    billingDate.setMonth(billingDate.getMonth() + 1);
    // Adjust for different month lengths
    const nextMonthDays = new Date(
      billingDate.getFullYear(),
      billingDate.getMonth() + 1,
      0
    ).getDate();
    billingDate.setDate(Math.min(normalizedBillingDay, nextMonthDays));
  }

  // Ensure billing date is not too far in the future (max 32 days)
  const maxDaysFromNow = 32;
  const maxTimestamp = today.getTime() + maxDaysFromNow * 24 * 60 * 60 * 1000;

  if (billingDate.getTime() > maxTimestamp) {
    // Fallback: use next month on the same day
    billingDate = new Date(today);
    billingDate.setMonth(billingDate.getMonth() + 1);
    billingDate.setDate(normalizedBillingDay);
  }

  console.log(`Billing anchor calculation:
    Today: ${today.toISOString()}
    Requested billing day: ${billingDay}
    Calculated billing date: ${billingDate.toISOString()}
    Unix timestamp: ${Math.floor(billingDate.getTime() / 1000)}
  `);

  return Math.floor(billingDate.getTime() / 1000);
};

const sendBankTransferPendingEmail = async (order) => {
  try {
    // Get user from the order
    const user = await User.findById(order.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for order:", order.donationId);
      return;
    }

    console.log(
      "Attempting to send bank transfer pending email to:",
      user.email
    );

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Bank Transfer Donation Pending</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>Thank you for your generous donation to the Shahid Afridi Foundation. Your donation is currently pending approval.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Date:</strong> ${new Date(
            order.createdAt
          ).toLocaleDateString()}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
        </div>

        <div style="background-color: #fffaed; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <h3 style="margin-top: 0; color: #856404;">Next Steps:</h3>
          <p>To complete your donation, please either:</p>
          <ol style="padding-left: 20px;">
            <li>Upload proof of payment through our website using your donation ID: ${
              order.donationId
            }</li>
            <li>Email your payment proof to: info@ShahidAfridiFoundation.org.au</li>
          </ol>
          <p>Your donation will be processed once we receive and verify your payment proof.</p>
        </div>
        
        <p>Thank you for your support!</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Bank Transfer Donation Pending - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error(
        "Failed to send bank transfer pending email:",
        result.error
      );
      console.error("Email details:", {
        to: user.email,
        subject: "Bank Transfer Donation Pending - Shahid Afridi Foundation",
        donationId: order.donationId,
      });
    } else {
      console.log(
        "Bank transfer pending email sent successfully to:",
        user.email
      );
    }
  } catch (error) {
    console.error("Error sending bank transfer pending email:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      donationId: order.donationId,
    });
  }
};

const sendCancellationRequestEmail = async (order) => {
  try {
    // Get user from the order
    const user = await User.findById(order.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for order:", order.donationId);
      return;
    }

    // Send email to admin
    const adminEmailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4a7c59;">Subscription Cancellation Request</h2>
        
        <p>A donor has requested to cancel their recurring donation.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Donor Name:</strong> ${user.name}</p>
          <p><strong>Donor Email:</strong> ${user.email}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${order.recurringDetails.frequency}</p>
          <p><strong>Start Date:</strong> ${new Date(
            order.recurringDetails.startDate
          ).toLocaleDateString()}</p>
        </div>

        <p>Please review this request and take appropriate action through the admin panel.</p>
      </div>
    `;

    await sendEmail(
      "info@shahidafridifoundation.org.au",
      //THIS IS MARYAM'S EMAIL FOR TESTING
      // Use the actual admin email here

      //info@shahidafridifoundation.org.au is the actual admin email
      adminEmailBody,
      "Subscription Cancellation Request - Shahid Afridi Foundation"
    );

    // Send confirmation email to donor
    const donorEmailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4a7c59;">Cancellation Request Received</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We have received your request to cancel your recurring donation.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${order.recurringDetails.frequency}</p>
        </div>

        <p>Our admin team will review your request and process it accordingly. You will receive another email once the cancellation is confirmed.</p>
        
        <p>Thank you for your support!</p>
      </div>
    `;

    await sendEmail(
      user.email,
      donorEmailBody,
      "Cancellation Request Received - Shahid Afridi Foundation"
    );

    console.log(
      `Cancellation request emails sent for order: ${order.donationId}`
    );
  } catch (error) {
    console.error("Error sending cancellation request emails:", error);
  }
};

exports.requestCancellation = async (req, res) => {
  try {
    const { donationId } = req.params;
    const order = await Order.findOne({ donationId });

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Donation not found",
      });
    }

    // Check if this is a recurring donation
    if (order.paymentType !== "recurring") {
      return res.status(400).json({
        status: "Error",
        message: "Only recurring donations can be cancelled",
      });
    }

    // Check if already pending cancellation
    if (order.paymentStatus === "pending_cancellation") {
      return res.status(400).json({
        status: "Error",
        message: "Cancellation request already pending",
      });
    }

    // Update order status to pending cancellation
    order.paymentStatus = "pending_cancellation";
    await order.save();

    // Send cancellation request emails
    await sendCancellationRequestEmail(order);

    res.json({
      status: "Success",
      message: "Cancellation request submitted successfully",
      order: {
        donationId: order.donationId,
        paymentStatus: order.paymentStatus,
      },
    });
  } catch (error) {
    console.error("Error processing cancellation request:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to process cancellation request",
      error: error.message,
    });
  }
};

exports.createOrder = async (req, res) => {
  try {
    const {
      items,
      paymentType,
      adminCostContribution,
      donorDetails,
      paymentMethod,
      totalAmount,
      recurringDetails,
      installmentDetails,
      stripePaymentMethodId,
      updateUserDetails,
      donationType,
    } = req.body;

    console.log("Received order data:", req.body);
    console.log("🔍 DEBUG: stripePaymentMethodId received:", stripePaymentMethodId);
    console.log("🔍 DEBUG: Full request body:", JSON.stringify(req.body, null, 2));

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
      if (!recurringDetails || !recurringDetails.frequency) {
        return res.status(400).json({
          status: "Error",
          message: "Recurring payment requires frequency",
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

    console.log("Donor Details", donorDetails);

    // Update donor details if needed
    if (donorDetails.rememberDetails && user) {
      await User.findByIdAndUpdate(user._id, {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
      });
    }
    console.log("Donor Details2", donorDetails);

    // Process items array
    const processedItems = items.map((item) => ({
      title: item.title,
      price: item.price,
      quantity: item.quantity || 1,
      onBehalfOf: item.onBehalfOf || null,
    }));

    // Capture the current day for recurring billing
    const today = new Date();
    const billingDay = today.getDate();

    // Build recurring details only if paymentType is "recurring"
    let orderRecurringDetails;
    if (paymentType === "recurring") {
      orderRecurringDetails = {
        frequency: recurringDetails.frequency,
        amount: totalAmount, // Use the full donation amount instead of partial
        startDate: new Date(),
        endDate: recurringDetails.endDate
          ? new Date(recurringDetails.endDate)
          : null,
        status: "active",
        nextPaymentDate: calculateNextPaymentDate(
          new Date(),
          recurringDetails.frequency,
          billingDay // Pass billing day to function
        ),
        billingDay: billingDay, // Store the billing day
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
      paymentStatus:
        paymentMethod === "bank"
          ? "pending"
          : paymentMethod === "paypal" && paymentType === "single"
          ? "completed"
          : "active",
      totalAmount,
      transactionDetails: {},
      recurringDetails:
        paymentType === "recurring" ? orderRecurringDetails : undefined,
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
          order.donationId = `D${Date.now()}${Math.floor(Math.random() * 10000)
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
        console.error(
          "Failed to create user account for donor:",
          userCreateError
        );
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
            automatic_payment_methods: {
              enabled: true,
            },
            description: `Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
            },
          });

          savedOrder.transactionDetails = {
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
            clientSecret: paymentIntent.client_secret,
          };

          // Payment intent created but not confirmed yet
          // Frontend will handle confirmation using client_secret
          savedOrder.paymentStatus = "pending";
          await savedOrder.save();
        } else if (paymentType === "recurring") {
          // Recurring payment processing
          let customer;
          try {
            console.log(`🔍 Validating payment method: ${stripePaymentMethodId}`);
            const paymentMethodObj = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );
            console.log(` Payment method ${stripePaymentMethodId} is valid`);
            if (paymentMethodObj.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethodObj.customer}`
              );
              customer = await stripe.customers.retrieve(
                paymentMethodObj.customer
              );
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
              invoice_settings: {
                default_payment_method: stripePaymentMethodId,
              },
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

          // Create subscription with billing cycle anchor for consistent charging
          // Create subscription - handle daily differently to avoid proration
          let subscriptionData;

          if (recurringDetails.frequency === "daily") {
            // For daily subscriptions, create without billing anchor and use specific settings
            subscriptionData = {
              customer: customer.id,
              items: [
                {
                  price_data: {
                    currency: "aud",
                    product: product.id,
                    unit_amount: Math.round(totalAmount * 100),
                    recurring: {
                      interval: "day",
                      interval_count: 1,
                    },
                  },
                },
              ],
              payment_settings: {
                save_default_payment_method: "on_subscription",
                payment_method_types: ["card"],
              },
              default_payment_method: stripePaymentMethodId,
              expand: ["latest_invoice.payment_intent"],
              proration_behavior: "none",
              // Force immediate billing without proration
              billing_cycle_anchor: Math.floor(Date.now() / 1000),
            };
          } else {
            // For other frequencies, use the existing logic
            subscriptionData = {
              customer: customer.id,
              items: [
                {
                  price_data: {
                    currency: "aud",
                    product: product.id,
                    unit_amount: Math.round(totalAmount * 100),
                    recurring: {
                      interval: interval,
                      interval_count: 1,
                    },
                  },
                },
              ],
              payment_settings: {
                save_default_payment_method: "on_subscription",
                payment_method_types: ["card"],
              },
              default_payment_method: stripePaymentMethodId,
              expand: ["latest_invoice.payment_intent"],
              proration_behavior: "none",
            };

            // Handle billing anchor for monthly only
            if (recurringDetails.frequency === "monthly") {
              const billingAnchor = calculateBillingAnchor(billingDay);
              if (billingAnchor !== null) {
                subscriptionData.billing_cycle_anchor = billingAnchor;
                console.log(
                  `Monthly subscription billing anchor set to: ${new Date(
                    billingAnchor * 1000
                  ).toISOString()}`
                );
              }
            }
          }

          console.log(
            `Creating ${recurringDetails.frequency} subscription with data:`,
            JSON.stringify(subscriptionData, null, 2)
          );

          // ADD END DATE IF PROVIDED
          if (recurringDetails.endDate) {
            // Set cancellation to end of the end date to ensure last payment is processed
            const endDate = new Date(recurringDetails.endDate);
            endDate.setHours(23, 59, 59, 999); // End of day
            const cancelAtTimestamp = Math.floor(endDate.getTime() / 1000);
            subscriptionData.cancel_at = cancelAtTimestamp;
            console.log(
              `Subscription will cancel at end of ${
                recurringDetails.endDate
              }: ${new Date(cancelAtTimestamp * 1000).toISOString()}`
            );
          }

          const subscription = await stripe.subscriptions.create(
            subscriptionData
          );
          console.log(
            `Created subscription: ${subscription.id} for customer ${customer.id}, status: ${subscription.status}`
          );

          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripeSubscriptionId: subscription.id,
            stripeStatus: subscription.status,
            clientSecret:
              subscription.latest_invoice?.payment_intent?.client_secret ||
              null,
          };

          if (subscription.status === "active") {
            savedOrder.paymentStatus = "active";

            // Check if the first invoice was paid
            let firstInvoicePaid = false;
            let paymentIntent = subscription.latest_invoice?.payment_intent;

            if (paymentIntent && paymentIntent.status === "succeeded") {
              firstInvoicePaid = true;
            } else if (
              subscription.latest_invoice &&
              paymentIntent &&
              paymentIntent.status !== "succeeded"
            ) {
              // Attempt to pay the invoice immediately if not already paid
              try {
                const paidInvoice = await stripe.invoices.pay(
                  subscription.latest_invoice.id
                );
                if (
                  paidInvoice.payment_intent &&
                  paidInvoice.payment_intent.status === "succeeded"
                ) {
                  paymentIntent = paidInvoice.payment_intent;
                  firstInvoicePaid = true;
                }
              } catch (payErr) {
                console.error(
                  "Failed to pay first recurring invoice immediately:",
                  payErr
                );
              }
            }

            if (firstInvoicePaid) {
              savedOrder.recurringDetails.totalPayments = 1;
              savedOrder.recurringDetails.lastPaymentDate = new Date();
              savedOrder.recurringDetails.paymentHistory = [
                {
                  date: new Date(),
                  amount: totalAmount,
                  invoiceId: subscription.latest_invoice.id,
                  status: "succeeded",
                },
              ];

              // Set next payment date using billing anchor for monthly
              if (interval === "month") {
                savedOrder.recurringDetails.nextPaymentDate = new Date(
                  calculateBillingAnchor(billingDay) * 1000
                );
              }

              try {
                await sendReceiptEmail(savedOrder);
              } catch (emailError) {
                console.error("Failed to send receipt email:", emailError);
              }
            }
          } else if (subscription.status === "incomplete") {
            savedOrder.paymentStatus = "pending";

            if (subscription.latest_invoice?.payment_intent) {
              try {
                const confirmedPI = await stripe.paymentIntents.confirm(
                  subscription.latest_invoice.payment_intent.id,
                  { payment_method: stripePaymentMethodId }
                );

                if (confirmedPI.status === "succeeded") {
                  const updatedSubscription =
                    await stripe.subscriptions.retrieve(subscription.id);
                  if (updatedSubscription.status === "active") {
                    savedOrder.paymentStatus = "active";
                    savedOrder.recurringDetails.totalPayments = 1;
                    savedOrder.recurringDetails.lastPaymentDate = new Date();
                    savedOrder.recurringDetails.paymentHistory = [
                      {
                        date: new Date(),
                        amount: totalAmount,
                        invoiceId: subscription.latest_invoice.id,
                        status: "succeeded",
                      },
                    ];

                    if (interval === "month") {
                      savedOrder.recurringDetails.nextPaymentDate = new Date(
                        calculateBillingAnchor(billingDay) * 1000
                      );
                    }

                    try {
                      await sendReceiptEmail(savedOrder);
                    } catch (emailError) {
                      console.error(
                        "Failed to send receipt email:",
                        emailError
                      );
                    }
                  }
                }
              } catch (confirmError) {
                console.error(
                  "Failed to confirm payment intent:",
                  confirmError
                );
              }
            }
          } else {
            savedOrder.paymentStatus = "pending";
          }

          // Ensure nextPaymentDate is null if it's new Date(0)
          if (savedOrder.recurringDetails?.nextPaymentDate && savedOrder.recurringDetails.nextPaymentDate.getTime() === 0) {
            console.log("DEBUG: nextPaymentDate is 1970-01-01, setting to null for order:", savedOrder._id);
            savedOrder.recurringDetails.nextPaymentDate = null;
          }

          console.log("DEBUG: savedOrder.recurringDetails.nextPaymentDate before final save:", savedOrder.recurringDetails?.nextPaymentDate);
          await savedOrder.save();
        } else if (paymentType === "installments") {
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
              customer = await stripe.customers.retrieve(
                paymentMethodObj.customer
              );
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
              invoice_settings: {
                default_payment_method: stripePaymentMethodId,
              },
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
                paymentIntent.status === "succeeded" ? "completed" : "active",
              transactionId: paymentIntent.id,
            });
          }

          if (paymentIntent.status === "succeeded") {
            try {
              await sendReceiptEmail(savedOrder);
            } catch (emailError) {
              console.error("Failed to send receipt email:", emailError);
            }
            savedOrder.paymentStatus = "active";
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
      try {
        await sendBankTransferPendingEmail(savedOrder);
        console.log(
          `Bank transfer pending email sent for order: ${savedOrder.donationId}`
        );
      } catch (emailError) {
        console.error(
          "Failed to send bank transfer pending email:",
          emailError
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
        recurringDetails:
          paymentType === "recurring" ? orderRecurringDetails : undefined,
        installmentDetails:
          paymentType === "installments" ? orderInstallmentDetails : undefined,
        transactionDetails: savedOrder.transactionDetails,
        clientSecret: savedOrder.transactionDetails.clientSecret,
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
    const userEmail = req.user.email;
    
    // Get regular orders
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select("-__v");

    // Get GoFundMe donations
    const goFundMeDonations = await GoFundMeDonation.find({ 
      donorEmail: userEmail,
      paymentStatus: { $in: ["completed", "pending"] }
    })
    .populate({
      path: "goFundMeId",
      select: "title slug category status currentAmount targetAmount image",
      populate: {
        path: "userId",
        select: "name",
      },
    })
    .sort({ createdAt: -1 })
    .select("donorName amount message isAnonymous paymentStatus paymentMethod transactionFee netAmount createdAt goFundMeId");

    // Transform GoFundMe donations to match order format
    const transformedDonations = goFundMeDonations.map(donation => ({
      _id: donation._id,
      type: "gofundme",
      totalAmount: donation.amount,
      paymentStatus: donation.paymentStatus,
      paymentMethod: donation.paymentMethod,
      createdAt: donation.createdAt,
      updatedAt: donation.updatedAt,
      // Additional GoFundMe specific fields
      goFundMe: donation.goFundMeId,
      message: donation.message,
      isAnonymous: donation.isAnonymous,
      transactionFee: donation.transactionFee,
      netAmount: donation.netAmount,
      donorName: donation.donorName
    }));

    // Combine and sort all transactions by creation date
    const allTransactions = [...orders, ...transformedDonations]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      status: "Success",
      orders: allTransactions,
      summary: {
        regularOrders: orders.length,
        goFundMeDonations: goFundMeDonations.length,
        totalTransactions: allTransactions.length
      }
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
    const { paymentStatus, transactionDetails, recurringStatus } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    // Update payment status if provided
    if (paymentStatus) {
      order.paymentStatus = paymentStatus;
    }

    // Update transaction details if provided
    if (transactionDetails) {
      order.transactionDetails = transactionDetails;
    }

    // Handle recurring donations
    if (order.paymentType === "recurring") {
      // Initialize recurringDetails if it doesn't exist
      if (!order.recurringDetails) {
        order.recurringDetails = {
          status: "active", // Default status for new recurring donations
          startDate: new Date(),
          nextPaymentDate: calculateNextPaymentDate(
            new Date(),
            order.recurringDetails?.frequency || "monthly"
          ),
        };
      }

      // Update recurring status if provided
      if (recurringStatus) {
        order.recurringDetails.status = recurringStatus;
      }

      // If this is a new approval, ensure the status is set to active
      if (paymentStatus === "completed" && !recurringStatus) {
        order.recurringDetails.status = "active";
      }
    }

    await order.save();

    // Create log entry
    await createLog("UPDATE", "ORDER", order._id, req.user, req, {
      paymentStatus,
      ...(recurringStatus && { recurringStatus }),
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
    const userEmail = req.user.email;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    console.log("Getting order stats for user:", req.user);

    // Get all orders for the user
    const orders = await Order.find({ user: userId });

    // Get all GoFundMe donations for the user
    const goFundMeDonations = await GoFundMeDonation.find({ 
      donorEmail: userEmail,
      paymentStatus: { $in: ["completed", "pending"] } // Include only valid donations
    });

    // Filter out failed orders for all KPIs and calculations
    const validOrders = orders.filter(
      (order) => order.paymentStatus !== "failed"
    );

    // Calculate total donated amount (including all installments and recurring payments)
    let totalDonated = 0;
    let paidDonated = 0; // Amount actually paid/received

    // Add GoFundMe donations to the totals
    goFundMeDonations.forEach(donation => {
      totalDonated += donation.amount;
      if (donation.paymentStatus === "completed") {
        paidDonated += donation.amount;
      }
    });

    await Promise.all(
      validOrders.map(async (order) => {
        // For one-time payments, use the total amount
        if (order.paymentType === "single") {
          totalDonated += order.totalAmount;
          if (
            order.paymentStatus === "completed" ||
            order.paymentStatus === "succeeded"
          ) {
            paidDonated += order.totalAmount;
          }
        }
        // For installments
        else if (
          order.paymentType === "installments" &&
          order.installmentDetails
        ) {
          // If cancelled, only count paid installments
          if (order.paymentStatus === "cancelled") {
            const paidInstallments =
              order.installmentDetails.installmentsPaid || 0;
            totalDonated +=
              paidInstallments * order.installmentDetails.installmentAmount;
            paidDonated +=
              paidInstallments * order.installmentDetails.installmentAmount;
          } else {
            // Total expected amount for installments
            const totalExpectedAmount =
              order.installmentDetails.numberOfInstallments *
              order.installmentDetails.installmentAmount;
            totalDonated += totalExpectedAmount;
            // Actually paid installments
            const paidInstallments =
              order.installmentDetails.installmentsPaid || 0;
            paidDonated +=
              paidInstallments * order.installmentDetails.installmentAmount;
          }
        }
        // For recurring donations
        else if (order.paymentType === "recurring" && order.recurringDetails) {
          try {
            // If cancelled, only count what was actually paid
            if (order.paymentStatus === "cancelled") {
              let actuallyPaid = 0;
              if (
                order.transactionDetails?.stripeSubscriptionId &&
                (order.paymentMethod === "visa" ||
                  order.paymentMethod === "mastercard")
              ) {
                const invoices = await stripe.invoices.list({
                  subscription: order.transactionDetails.stripeSubscriptionId,
                  status: "paid",
                  limit: 100,
                });
                actuallyPaid = invoices.data.reduce(
                  (sum, invoice) => sum + invoice.amount_paid / 100,
                  0
                );
              } else if (
                order.recurringDetails.paymentHistory &&
                order.recurringDetails.paymentHistory.length > 0
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else {
                const totalPaymentsMade =
                  order.recurringDetails.totalPayments || 0;
                actuallyPaid =
                  totalPaymentsMade * order.recurringDetails.amount;
              }
              totalDonated += actuallyPaid;
              paidDonated += actuallyPaid;
            } else {
              // Calculate total expected amount based on frequency and duration
              const totalExpectedAmount = calculateRecurringTotalAmount(order);
              totalDonated += totalExpectedAmount;
              // Get actually paid amount
              let actuallyPaid = 0;
              if (
                order.transactionDetails?.stripeSubscriptionId &&
                (order.paymentMethod === "visa" ||
                  order.paymentMethod === "mastercard")
              ) {
                const invoices = await stripe.invoices.list({
                  subscription: order.transactionDetails.stripeSubscriptionId,
                  status: "paid",
                  limit: 100,
                });
                actuallyPaid = invoices.data.reduce(
                  (sum, invoice) => sum + invoice.amount_paid / 100,
                  0
                );
              } else if (
                order.recurringDetails.paymentHistory &&
                order.recurringDetails.paymentHistory.length > 0
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else if (
                order.paymentStatus === "active" ||
                order.paymentStatus === "completed" ||
                order.paymentStatus === "cancelled"
              ) {
                const totalPaymentsMade =
                  order.recurringDetails.totalPayments || 0;
                actuallyPaid =
                  totalPaymentsMade * order.recurringDetails.amount;
              }
              paidDonated += actuallyPaid;
            }
          } catch (stripeError) {
            console.error("Error fetching Stripe payment data:", stripeError);
            // Fallback for cancelled
            if (order.paymentStatus === "cancelled") {
              let actuallyPaid = 0;
              if (
                order.recurringDetails &&
                order.recurringDetails.paymentHistory
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else {
                const totalPaymentsMade =
                  order.recurringDetails?.totalPayments || 0;
                actuallyPaid =
                  totalPaymentsMade * (order.recurringDetails?.amount || 0);
              }
              totalDonated += actuallyPaid;
              paidDonated += actuallyPaid;
            } else {
              const totalExpectedAmount = calculateRecurringTotalAmount(order);
              totalDonated += totalExpectedAmount;
              let actuallyPaid = 0;
              if (
                order.recurringDetails &&
                order.recurringDetails.paymentHistory
              ) {
                actuallyPaid = order.recurringDetails.paymentHistory
                  .filter((payment) => payment.status === "succeeded")
                  .reduce((sum, payment) => sum + (payment.amount || 0), 0);
              } else if (order.paymentStatus !== "failed") {
                const totalPaymentsMade =
                  order.recurringDetails?.totalPayments || 0;
                actuallyPaid =
                  totalPaymentsMade * (order.recurringDetails?.amount || 0);
              }
              paidDonated += actuallyPaid;
            }
          }
        }
      })
    );

    // Use validOrders for all KPIs and stats
    const recurringOrders = validOrders.filter(
      (order) =>
        order.paymentType === "recurring" ||
        order.paymentType === "installments"
    );

    // Calculate active recurring (not failed or completed or cancelled)
    const activeRecurring = recurringOrders.filter(
      (order) =>
        order.paymentStatus === "active" || order.paymentStatus === "pending"
    ).length;

    // Count one-time donations
    const oneTimeOrders = validOrders.filter(
      (order) => order.paymentType === "single"
    );

    const stats = {
      totalDonated, // Total expected amount (including future recurring payments, but not for cancelled)
      paidDonated, // Amount actually received/paid
      activeRecurring,
      recurringCount: recurringOrders.length,
      oneTimeCount: oneTimeOrders.length,
      totalOrders: validOrders.length,
      // GoFundMe donation stats
      goFundMeDonationsCount: goFundMeDonations.length,
      goFundMeCompletedCount: goFundMeDonations.filter(d => d.paymentStatus === "completed").length,
      goFundMePendingCount: goFundMeDonations.filter(d => d.paymentStatus === "pending").length,
      // Additional stats
      completedOrders: validOrders.filter(
        (order) => order.paymentStatus === "completed"
      ).length,
      pendingOrders: validOrders.filter(
        (order) => order.paymentStatus === "pending"
      ).length,
      pendingAmount: validOrders.reduce((sum, order) => {
        // Exclude cancelled orders from pending calculation
        if (order.paymentStatus === "cancelled") {
          return sum;
        }
        // Add amount for pending orders
        if (order.paymentStatus === "pending") {
          return sum + order.totalAmount;
        }
        // Add remaining installment amounts for active installment orders
        if (
          order.paymentType === "installments" &&
          order.installmentDetails &&
          order.paymentStatus === "active" &&
          order.installmentDetails.status === "active"
        ) {
          const totalInstallments =
            order.installmentDetails.numberOfInstallments;
          const paidInstallments =
            order.installmentDetails.installmentsPaid || 0;
          const remainingInstallments = totalInstallments - paidInstallments;
          const installmentAmount = order.installmentDetails.installmentAmount;

          // Calculate remaining amount
          const remainingAmount = remainingInstallments * installmentAmount;
          return sum + remainingAmount;
        }
        // Add remaining recurring payments for active recurring orders
        if (
          order.paymentType === "recurring" &&
          order.recurringDetails &&
          order.paymentStatus === "active"
        ) {
          const totalExpectedAmount = calculateRecurringTotalAmount(order);
          const totalPaymentsMade = order.recurringDetails.totalPayments || 0;
          const paidAmount = totalPaymentsMade * order.recurringDetails.amount;
          const remainingAmount = Math.max(0, totalExpectedAmount - paidAmount);
          return sum + remainingAmount;
        }
        // Do NOT include cancelled subscriptions' future amounts
        return sum;
      }, 0),
      failedOrders: orders.filter((order) => order.paymentStatus === "failed")
        .length,
      cancelledOrders: validOrders.filter(
        (order) => order.paymentStatus === "cancelled"
      ).length,
      // Monthly stats (filter to requested or current month)
      monthlyStats: await getMonthlyStats(validOrders, stripe, req.query.month),
      // Add average donation (including GoFundMe donations)
      averageDonation:
        (validOrders.length + goFundMeDonations.length) > 0
          ? Number((totalDonated / (validOrders.length + goFundMeDonations.length)).toFixed(2))
          : 0,
    };

    // Add yearly stats if requested
    if (req.query.yearly === 'true') {
      stats.yearlyStats = await getYearlyStats(validOrders, goFundMeDonations, stripe);
    }

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

// Helper function to calculate total expected amount for recurring donations
const calculateRecurringTotalAmount = (order) => {
  if (!order.recurringDetails) return 0;

  const { amount, frequency, startDate, endDate } = order.recurringDetails;

  if (!startDate || !endDate) {
    // If no end date specified, just return the amount of payments made so far
    const totalPaymentsMade = order.recurringDetails.totalPayments || 0;
    return totalPaymentsMade * amount;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Calculate total expected payments based on frequency
  let totalPayments = 0;

  switch (frequency.toLowerCase()) {
    case "daily":
      totalPayments = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
      break;
    case "weekly":
      totalPayments = Math.ceil((end - start) / (1000 * 60 * 60 * 24 * 7)) + 1;
      break;
    case "monthly":
      // FIXED: Proper monthly calculation
      const startYear = start.getFullYear();
      const startMonth = start.getMonth();
      const startDay = start.getDate();
      const endYear = end.getFullYear();
      const endMonth = end.getMonth();
      const endDay = end.getDate();

      // Calculate months difference
      let monthsDiff = (endYear - startYear) * 12 + (endMonth - startMonth);

      // If end day is >= start day, include the final month
      if (endDay >= startDay) {
        monthsDiff += 1;
      }

      totalPayments = Math.max(1, monthsDiff); // At least 1 payment
      break;
    case "yearly":
      totalPayments = end.getFullYear() - start.getFullYear() + 1;
      break;
    default:
      // If frequency is not recognized, use totalPayments from order if available
      totalPayments = order.recurringDetails.totalPayments || 1;
  }

  return totalPayments * amount;
};

const getYearlyStats = async (orders, goFundMeDonations, stripe) => {
  // Collect per-month totals for the current year
  const monthlyData = {}; // { 'YYYY-MM': { total, count } }
  const currentYear = new Date().getFullYear();

  // Process regular orders
  for (const order of orders) {
    const initialDate = new Date(order.createdAt);
    const initialYear = initialDate.getFullYear();
    
    if (initialYear !== currentYear) continue; // Only process current year

    const monthKey = `${initialYear}-${String(initialDate.getMonth() + 1).padStart(2, "0")}`;

    // For one-time payments, add the full amount to the creation month
    if (order.paymentType === "single") {
      if (!monthlyData[monthKey]) monthlyData[monthKey] = { total: 0, count: 0 };
      monthlyData[monthKey].total += order.totalAmount;
      monthlyData[monthKey].count += 1;
    }
    // For recurring/installments, process payment history
    else {
      // Handle recurring payments by fetching Stripe data if possible
      if (
        order.paymentType === "recurring" &&
        order.transactionDetails?.stripeSubscriptionId &&
        (order.paymentMethod === "visa" || order.paymentMethod === "mastercard")
      ) {
        try {
          // Get all paid invoices for this subscription
          const invoices = await stripe.invoices.list({
            subscription: order.transactionDetails.stripeSubscriptionId,
            status: "paid",
            limit: 100,
          });

          // Process each invoice
          for (const invoice of invoices.data) {
            const paymentDate = new Date(invoice.status_transitions.paid_at * 1000);
            const paymentYear = paymentDate.getFullYear();
            
            if (paymentYear === currentYear) {
              const paymentMonthKey = `${paymentYear}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}`;
              if (!monthlyData[paymentMonthKey]) monthlyData[paymentMonthKey] = { total: 0, count: 0 };
              monthlyData[paymentMonthKey].total += invoice.amount_paid / 100; // Convert from cents
              monthlyData[paymentMonthKey].count += 1;
            }
          }
        } catch (stripeError) {
          console.error("Error fetching Stripe invoice data:", stripeError);
          // Fall back to local data
          if (order.recurringDetails && order.recurringDetails.paymentHistory) {
            order.recurringDetails.paymentHistory
              .filter((p) => p.status === "succeeded")
              .forEach((payment) => {
                const paymentDate = payment.date ? new Date(payment.date) : initialDate;
                const paymentYear = paymentDate.getFullYear();
                
                if (paymentYear === currentYear) {
                  const paymentMonthKey = `${paymentYear}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}`;
                  if (!monthlyData[paymentMonthKey]) monthlyData[paymentMonthKey] = { total: 0, count: 0 };
                  monthlyData[paymentMonthKey].total += payment.amount;
                  monthlyData[paymentMonthKey].count += 1;
                }
              });
          }
        }
      }
      // Handle installment payments
      else if (order.paymentType === "installments" && order.installmentDetails) {
        if (order.installmentDetails.installmentHistory && order.installmentDetails.installmentHistory.length > 0) {
          order.installmentDetails.installmentHistory
            .filter((h) => h.status === "completed")
            .forEach((installment) => {
              const paymentDate = installment.date ? new Date(installment.date) : initialDate;
              const paymentYear = paymentDate.getFullYear();
              
              if (paymentYear === currentYear) {
                const paymentMonthKey = `${paymentYear}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}`;
                if (!monthlyData[paymentMonthKey]) monthlyData[paymentMonthKey] = { total: 0, count: 0 };
                monthlyData[paymentMonthKey].total += installment.amount;
                monthlyData[paymentMonthKey].count += 1;
              }
            });
        } else {
          // If no history, add first installment to creation month
          if (initialYear === currentYear) {
            if (!monthlyData[monthKey]) monthlyData[monthKey] = { total: 0, count: 0 };
            monthlyData[monthKey].total += order.installmentDetails.installmentAmount;
            monthlyData[monthKey].count += 1;
          }
        }
      }
      // Fall back for recurring payments without Stripe ID
      else if (order.paymentType === "recurring" && order.recurringDetails) {
        if (order.recurringDetails.paymentHistory && order.recurringDetails.paymentHistory.length > 0) {
          order.recurringDetails.paymentHistory
            .filter((p) => p.status === "succeeded")
            .forEach((payment) => {
              const paymentDate = payment.date ? new Date(payment.date) : initialDate;
              const paymentYear = paymentDate.getFullYear();
              
              if (paymentYear === currentYear) {
                const paymentMonthKey = `${paymentYear}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}`;
                if (!monthlyData[paymentMonthKey]) monthlyData[paymentMonthKey] = { total: 0, count: 0 };
                monthlyData[paymentMonthKey].total += payment.amount;
                monthlyData[paymentMonthKey].count += 1;
              }
            });
        } else {
          // If no payment history, add first payment to creation month
          if (initialYear === currentYear) {
            if (!monthlyData[monthKey]) monthlyData[monthKey] = { total: 0, count: 0 };
            monthlyData[monthKey].total += order.recurringDetails.amount;
            monthlyData[monthKey].count += 1;
          }
        }
      }
    }
  }

  // Process GoFundMe donations
  for (const donation of goFundMeDonations) {
    const donationDate = new Date(donation.createdAt);
    const donationYear = donationDate.getFullYear();
    
    if (donationYear === currentYear) {
      const monthKey = `${donationYear}-${String(donationDate.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyData[monthKey]) monthlyData[monthKey] = { total: 0, count: 0 };
      monthlyData[monthKey].total += donation.amount;
      monthlyData[monthKey].count += 1;
    }
  }

  // Convert to array format with month names
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const monthlyArray = [];
  for (let month = 1; month <= 12; month++) {
    const monthKey = `${currentYear}-${String(month).padStart(2, "0")}`;
    const data = monthlyData[monthKey] || { total: 0, count: 0 };
    
    monthlyArray.push({
      month: monthNames[month - 1],
      amount: Number(data.total.toFixed(2)),
      count: data.count
    });
  }

  return monthlyArray;
};

const getMonthlyStats = async (orders, stripe, requestedMonth) => {
  // Determine month filter once (YYYY-MM)
  const monthFilter = (requestedMonth || (() => {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    return `${now.getFullYear()}-${mm}`;
  })());

  // Collect per-day totals within the requested month
  const dailyData = {}; // { 'YYYY-MM-DD': { total, count } }

  // First, process all orders
  for (const order of orders) {
    const initialDate = new Date(order.createdAt);
    const initialMonthYear = `${initialDate.getFullYear()}-${String(initialDate.getMonth() + 1).padStart(2, "0")}`;
    const initialDay = `${initialDate.getFullYear()}-${String(initialDate.getMonth() + 1).padStart(2, "0")}-${String(initialDate.getDate()).padStart(2, "0")}`;

    // For one-time payments, add the full amount to the creation month
    if (order.paymentType === "single") {
      if (initialMonthYear === monthFilter) {
        if (!dailyData[initialDay]) dailyData[initialDay] = { total: 0, count: 0 };
        dailyData[initialDay].total += order.totalAmount;
        dailyData[initialDay].count += 1;
      }
    }
    // For recurring/installments, mark as recurring in the creation month
    else {
      // Handle recurring payments by fetching Stripe data if possible
      if (
        order.paymentType === "recurring" &&
        order.transactionDetails?.stripeSubscriptionId &&
        (order.paymentMethod === "visa" || order.paymentMethod === "mastercard")
      ) {
        try {
          // Get all paid invoices for this subscription
          const invoices = await stripe.invoices.list({
            subscription: order.transactionDetails.stripeSubscriptionId,
            status: "paid",
            limit: 100,
          });

          // Process each invoice
          for (const invoice of invoices.data) {
            const paymentDate = new Date(
              invoice.status_transitions.paid_at * 1000
            );
            const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
              paymentDate.getMonth() + 1
            ).padStart(2, "0")}`;
            const paymentDay = `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}-${String(paymentDate.getDate()).padStart(2, "0")}`;

            if (paymentMonthYear === monthFilter) {
              if (!dailyData[paymentDay]) dailyData[paymentDay] = { total: 0, count: 0 };
              dailyData[paymentDay].total += invoice.amount_paid / 100; // Convert from cents
              dailyData[paymentDay].count += 1;
            }
          }
        } catch (stripeError) {
          console.error("Error fetching Stripe invoice data:", stripeError);

          // Fall back to local data - process each payment from paymentHistory
          if (order.recurringDetails && order.recurringDetails.paymentHistory) {
            order.recurringDetails.paymentHistory
              .filter((p) => p.status === "succeeded")
              .forEach((payment) => {
                const paymentDate = payment.date
                  ? new Date(payment.date)
                  : initialDate;
                const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
                  paymentDate.getMonth() + 1
                ).padStart(2, "0")}`;
                const paymentDay = `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}-${String(paymentDate.getDate()).padStart(2, "0")}`;

                if (paymentMonthYear === monthFilter) {
                  if (!dailyData[paymentDay]) dailyData[paymentDay] = { total: 0, count: 0 };
                  dailyData[paymentDay].total += payment.amount;
                  dailyData[paymentDay].count += 1;
                }
              });
          }
        }
      }
      // Handle installment payments
      else if (
        order.paymentType === "installments" &&
        order.installmentDetails
      ) {
        // Process all installment payments based on their dates
        if (
          order.installmentDetails.installmentHistory &&
          order.installmentDetails.installmentHistory.length > 0
        ) {
          order.installmentDetails.installmentHistory
            .filter((h) => h.status === "completed")
            .forEach((installment) => {
              // Use installment date if available, otherwise use order creation date
              const paymentDate = installment.date
                ? new Date(installment.date)
                : initialDate;
              const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
                paymentDate.getMonth() + 1
              ).padStart(2, "0")}`;
              const paymentDay = `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}-${String(paymentDate.getDate()).padStart(2, "0")}`;

              if (paymentMonthYear === monthFilter) {
                if (!dailyData[paymentDay]) dailyData[paymentDay] = { total: 0, count: 0 };
                dailyData[paymentDay].total += installment.amount;
                dailyData[paymentDay].count += 1;
              }
            });
        } else {
          // If no history, and creation month matches filter, add first installment to creation day
          if (initialMonthYear === monthFilter) {
            if (!dailyData[initialDay]) dailyData[initialDay] = { total: 0, count: 0 };
            dailyData[initialDay].total += order.installmentDetails.installmentAmount;
            dailyData[initialDay].count += 1;
          }
        }
      }
      // Fall back for recurring payments without Stripe ID
      else if (order.paymentType === "recurring" && order.recurringDetails) {
        if (
          order.recurringDetails.paymentHistory &&
          order.recurringDetails.paymentHistory.length > 0
        ) {
          order.recurringDetails.paymentHistory
            .filter((p) => p.status === "succeeded")
            .forEach((payment) => {
              const paymentDate = payment.date
                ? new Date(payment.date)
                : initialDate;
              const paymentMonthYear = `${paymentDate.getFullYear()}-${String(
                paymentDate.getMonth() + 1
              ).padStart(2, "0")}`;
              const paymentDay = `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, "0")}-${String(paymentDate.getDate()).padStart(2, "0")}`;

              if (paymentMonthYear === monthFilter) {
                if (!dailyData[paymentDay]) dailyData[paymentDay] = { total: 0, count: 0 };
                dailyData[paymentDay].total += payment.amount;
                dailyData[paymentDay].count += 1;
              }
            });
        } else {
          // If no payment history, and creation month matches, add first payment to creation day
          if (initialMonthYear === monthFilter) {
            if (!dailyData[initialDay]) dailyData[initialDay] = { total: 0, count: 0 };
            dailyData[initialDay].total += order.recurringDetails.amount;
            dailyData[initialDay].count += 1;
          }
        }
      }
    }
  }

  // Convert to array of daily entries within the month, sorted ascending by date
  const dailyArray = Object.entries(dailyData)
    .map(([date, data]) => ({ date, total: Number(data.total.toFixed(2)), count: data.count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Return daily breakdown if any; otherwise return empty array
  return dailyArray;
};

const calculateNextPaymentDate = (startDate, frequency, billingDay = null) => {
  const nextDate = new Date(startDate);

  switch (frequency) {
    case "daily":
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case "weekly":
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case "monthly":
      // For monthly payments, always move to next month and use billing day
      nextDate.setMonth(nextDate.getMonth() + 1);

      if (billingDay) {
        // Get days in the target month to handle edge cases
        const daysInMonth = new Date(
          nextDate.getFullYear(),
          nextDate.getMonth() + 1,
          0
        ).getDate();
        nextDate.setDate(Math.min(billingDay, daysInMonth));
      }
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

    // Log the order transaction details for debugging
    console.log(
      `Processing order ${orderId} with transaction details:`,
      JSON.stringify(order.transactionDetails || {}, null, 2)
    );
    console.log(
      `Payment type: ${order.paymentType}, Payment method: ${order.paymentMethod}`
    );

    // Ensure this is an active installment order with remaining installments.
    if (
      order.paymentType !== "installments" ||
      !order.installmentDetails ||
      order.installmentDetails.status !== "active" ||
      order.installmentDetails.installmentsPaid >=
        order.installmentDetails.numberOfInstallments
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

    // Check payment information and try to recover if missing
    if (
      !order.transactionDetails ||
      !order.transactionDetails.stripeCustomerId ||
      !order.transactionDetails.stripePaymentMethodId
    ) {
      console.error(`Missing payment method information for order: ${orderId}`);

      // If we have a customer ID but no payment method, try to get default payment method
      if (
        order.transactionDetails &&
        order.transactionDetails.stripeCustomerId
      ) {
        try {
          const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(
            order.transactionDetails.stripeCustomerId,
            { expand: ["default_source"] }
          );

          if (customer.default_source) {
            console.log(
              `Found default payment source for customer: ${customer.id}`
            );
            order.transactionDetails.stripePaymentMethodId =
              customer.default_source;
          } else if (
            customer.invoice_settings &&
            customer.invoice_settings.default_payment_method
          ) {
            console.log(
              `Found default payment method in invoice settings: ${customer.invoice_settings.default_payment_method}`
            );
            order.transactionDetails.stripePaymentMethodId =
              customer.invoice_settings.default_payment_method;
          } else {
            // Try to get the latest payment method
            const paymentMethods = await stripe.paymentMethods.list({
              customer: customer.id,
              type: "card",
              limit: 1,
            });

            if (paymentMethods.data.length > 0) {
              console.log(
                `Found payment method from list: ${paymentMethods.data[0].id}`
              );
              order.transactionDetails.stripePaymentMethodId =
                paymentMethods.data[0].id;
            }
          }

          // If we recovered a payment method, save it to the order
          if (order.transactionDetails.stripePaymentMethodId) {
            await order.save();
            console.log(
              `Recovered and saved payment method: ${order.transactionDetails.stripePaymentMethodId}`
            );
          }
        } catch (recoveryError) {
          console.error(
            `Error recovering payment method: ${recoveryError.message}`
          );
        }
      }

      // If still missing required info, we can't proceed
      if (
        !order.transactionDetails ||
        !order.transactionDetails.stripeCustomerId ||
        !order.transactionDetails.stripePaymentMethodId
      ) {
        throw new Error(
          "Critical payment information missing. Cannot process installment."
        );
      }
    }

    // Process payment with Stripe.
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Validate payment method exists before using it
    let paymentMethod;
    try {
      paymentMethod = await stripe.paymentMethods.retrieve(
        order.transactionDetails.stripePaymentMethodId
      );
      console.log(`✅ Payment method ${order.transactionDetails.stripePaymentMethodId} exists`);
    } catch (pmError) {
      console.error(`❌ Payment method ${order.transactionDetails.stripePaymentMethodId} not found:`, pmError.message);
      
      // Try to get the customer's default payment method instead
      try {
        const customer = await stripe.customers.retrieve(order.transactionDetails.stripeCustomerId);
        if (customer.invoice_settings?.default_payment_method) {
          console.log(`🔄 Using customer's default payment method: ${customer.invoice_settings.default_payment_method}`);
          paymentMethod = await stripe.paymentMethods.retrieve(customer.invoice_settings.default_payment_method);
          order.transactionDetails.stripePaymentMethodId = customer.invoice_settings.default_payment_method;
        } else {
          throw new Error("No valid payment method found for customer");
        }
      } catch (customerError) {
        console.error("❌ Error getting customer's default payment method:", customerError.message);
        throw new Error(`Payment method not found and no fallback available: ${pmError.message}`);
      }
    }

    // Now create and confirm the payment intent with validated payment method
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(order.installmentDetails.installmentAmount * 100),
      currency: "aud",
      customer: order.transactionDetails.stripeCustomerId,
      payment_method: order.transactionDetails.stripePaymentMethodId,
      off_session: true,
      confirm: true,
      payment_method_types: ["card"],
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
      const paymentIntervalDays =
        order.installmentDetails.paymentIntervalDays || 30;
      order.installmentDetails.nextInstallmentDate = new Date(
        Date.now() + paymentIntervalDays * 24 * 60 * 60 * 1000
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
      status: paymentIntent.status === "succeeded" ? "completed" : "active",
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

      // Check if the file was actually uploaded to S3
      if (!req.file.location) {
        return res.status(500).json({
          success: false,
          message: "Failed to upload file to storage",
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

      // Handle specific error cases
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          message: "File size must be less than 5MB",
        });
      }

      if (error.message === "Only image files are allowed!") {
        return res.status(400).json({
          success: false,
          message: "Only JPG, PNG, and GIF files are allowed",
        });
      }

      // Handle S3-specific errors
      if (error.name === "S3Error" || error.name === "NoSuchBucket") {
        return res.status(500).json({
          success: false,
          message: "Storage service error. Please try again later.",
        });
      }

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
        responseType: "arraybuffer",
      });

      // Determine content type based on the file name
      const fileName = receiptUrl.split("/").pop();
      const fileExt = path.extname(fileName).replace(".", "").toLowerCase();

      const contentTypes = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        pdf: "application/pdf",
      };

      const contentType = contentTypes[fileExt] || "application/octet-stream";

      // Set headers for inline display
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "public, max-age=300"); // Cache for 5 minutes

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

exports.generateStatement = async (req, res) => {
  try {
    const { financialYear } = req.query;
    const userId = req.user._id;

    // Validate financial year format (e.g., "2023-2024")
    if (!financialYear || !/^\d{4}-\d{4}$/.test(financialYear)) {
      return res.status(400).json({
        status: "Error",
        message: "Please provide a valid financial year in format YYYY-YYYY (e.g., 2023-2024)",
      });
    }

    const [startYear, endYear] = financialYear.split('-');
    
    // Validate that end year is start year + 1
    if (parseInt(endYear) !== parseInt(startYear) + 1) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid financial year format. End year must be start year + 1 (e.g., 2023-2024)",
      });
    }

    const startDate = new Date(parseInt(startYear), 6, 1); // July 1st
    const endDate = new Date(parseInt(startYear) + 1, 5, 30, 23, 59, 59); // June 30th

    console.log(`Generating statement for user ${userId} from ${startDate} to ${endDate}`);

    // Get all orders for the user in the financial year
    const orders = await Order.find({
      user: userId,
      createdAt: { $gte: startDate, $lte: endDate },
      paymentStatus: { $ne: "failed" }
    }).sort({ createdAt: 1 });

    // Get P2P donations (GoFundMe donations) for the user in the financial year
    const goFundMeDonations = await GoFundMeDonation.find({
      donorEmail: req.user.email,
      createdAt: { $gte: startDate, $lte: endDate },
      paymentStatus: "completed"
    }).populate('goFundMeId', 'title slug');

    // Check if user has any data for this financial year
    if (orders.length === 0 && goFundMeDonations.length === 0) {
      return res.status(404).json({
        status: "Error",
        message: "No donation data found for the specified financial year",
      });
    }

    // Initialize statement data
    const statement = {
      financialYear,
      user: {
        name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
        email: req.user.email,
        userId: userId
      },
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      summary: {
        totalDonations: 0,
        totalAmount: 0,
        totalRecurringPayments: 0,
        totalInstallmentPayments: 0,
        totalOneTimePayments: 0,
        totalP2PDonations: 0,
        totalP2PAmount: 0
      },
      breakdown: {
        oneTimePayments: [],
        recurringPayments: [],
        installmentPayments: [],
        p2pDonations: []
      },
      monthlySummary: {},
      paymentMethods: {}
    };

    // Process regular orders
    for (const order of orders) {
      const orderData = {
        donationId: order.donationId,
        paymentType: order.paymentType,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        lastPaymentDate: order.lastPaymentDate,
        donationType: order.donationType,
        items: order.items
      };

      // Calculate actual payments based on payment type
      let actualPayments = 0;
      let paymentHistory = [];

      if (order.paymentType === 'single') {
        if (order.paymentStatus === 'completed' || order.paymentStatus === 'succeeded') {
          actualPayments = order.totalAmount;
          paymentHistory.push({
            date: order.createdAt,
            amount: order.totalAmount,
            status: order.paymentStatus
          });
        }
      } else if (order.paymentType === 'recurring' && order.recurringDetails) {
        // Calculate recurring payments in the financial year
        const recurringPayments = order.recurringDetails.paymentHistory || [];
        const yearPayments = recurringPayments.filter(payment => 
          payment.date >= startDate && payment.date <= endDate && payment.status === 'succeeded'
        );
        
        actualPayments = yearPayments.reduce((sum, payment) => sum + payment.amount, 0);
        paymentHistory = yearPayments.map(payment => ({
          date: payment.date,
          amount: payment.amount,
          status: payment.status,
          invoiceId: payment.invoiceId
        }));

        orderData.recurringDetails = {
          frequency: order.recurringDetails.frequency,
          amount: order.recurringDetails.amount,
          status: order.recurringDetails.status,
          totalPayments: order.recurringDetails.totalPayments
        };
      } else if (order.paymentType === 'installments' && order.installmentDetails) {
        // Calculate installment payments in the financial year
        const installmentPayments = order.installmentDetails.installmentHistory || [];
        const yearInstallments = installmentPayments.filter(installment => 
          installment.date >= startDate && installment.date <= endDate && installment.status === 'completed'
        );
        
        actualPayments = yearInstallments.reduce((sum, installment) => sum + installment.amount, 0);
        paymentHistory = yearInstallments.map(installment => ({
          date: installment.date,
          amount: installment.amount,
          status: installment.status,
          installmentNumber: installment.installmentNumber,
          transactionId: installment.transactionId
        }));

        orderData.installmentDetails = {
          numberOfInstallments: order.installmentDetails.numberOfInstallments,
          installmentAmount: order.installmentDetails.installmentAmount,
          installmentsPaid: order.installmentDetails.installmentsPaid,
          status: order.installmentDetails.status
        };
      }

      orderData.actualPayments = actualPayments;
      orderData.paymentHistory = paymentHistory;

      // Add to appropriate category
      if (order.paymentType === 'single') {
        statement.breakdown.oneTimePayments.push(orderData);
        statement.summary.totalOneTimePayments += actualPayments;
      } else if (order.paymentType === 'recurring') {
        statement.breakdown.recurringPayments.push(orderData);
        statement.summary.totalRecurringPayments += actualPayments;
      } else if (order.paymentType === 'installments') {
        statement.breakdown.installmentPayments.push(orderData);
        statement.summary.totalInstallmentPayments += actualPayments;
      }

      // Update payment method summary
      if (!statement.paymentMethods[order.paymentMethod]) {
        statement.paymentMethods[order.paymentMethod] = 0;
      }
      statement.paymentMethods[order.paymentMethod] += actualPayments;
    }

    // Process P2P donations
    for (const donation of goFundMeDonations) {
      const donationData = {
        donationId: donation._id,
        campaignTitle: donation.goFundMeId.title,
        campaignSlug: donation.goFundMeId.slug,
        amount: donation.amount,
        netAmount: donation.netAmount,
        transactionFee: donation.transactionFee,
        paymentMethod: donation.paymentMethod,
        isAnonymous: donation.isAnonymous,
        message: donation.message,
        createdAt: donation.createdAt,
        donorName: donation.donorName
      };

      statement.breakdown.p2pDonations.push(donationData);
      statement.summary.totalP2PDonations += 1;
      statement.summary.totalP2PAmount += donation.amount;

      // Update payment method summary
      if (!statement.paymentMethods[donation.paymentMethod]) {
        statement.paymentMethods[donation.paymentMethod] = 0;
      }
      statement.paymentMethods[donation.paymentMethod] += donation.amount;
    }

    // Calculate totals
    statement.summary.totalDonations = 
      statement.breakdown.oneTimePayments.length +
      statement.breakdown.recurringPayments.length +
      statement.breakdown.installmentPayments.length +
      statement.breakdown.p2pDonations.length;

    statement.summary.totalAmount = 
      statement.summary.totalOneTimePayments +
      statement.summary.totalRecurringPayments +
      statement.summary.totalInstallmentPayments +
      statement.summary.totalP2PAmount;

    // Generate monthly summary
    const monthlyData = {};
    for (let month = 0; month < 12; month++) {
      const monthDate = new Date(startDate);
      monthDate.setMonth(startDate.getMonth() + month);
      const monthKey = monthDate.toISOString().slice(0, 7); // YYYY-MM format
      monthlyData[monthKey] = {
        oneTimePayments: 0,
        recurringPayments: 0,
        installmentPayments: 0,
        p2pDonations: 0,
        totalAmount: 0
      };
    }

    // Calculate monthly totals
    [...statement.breakdown.oneTimePayments, ...statement.breakdown.recurringPayments, 
     ...statement.breakdown.installmentPayments].forEach(order => {
      order.paymentHistory.forEach(payment => {
        const monthKey = payment.date.toISOString().slice(0, 7);
        if (monthlyData[monthKey]) {
          if (order.paymentType === 'single') {
            monthlyData[monthKey].oneTimePayments += payment.amount;
          } else if (order.paymentType === 'recurring') {
            monthlyData[monthKey].recurringPayments += payment.amount;
          } else if (order.paymentType === 'installments') {
            monthlyData[monthKey].installmentPayments += payment.amount;
          }
          monthlyData[monthKey].totalAmount += payment.amount;
        }
      });
    });

    // Add P2P donations to monthly summary
    statement.breakdown.p2pDonations.forEach(donation => {
      const monthKey = donation.createdAt.toISOString().slice(0, 7);
      if (monthlyData[monthKey]) {
        monthlyData[monthKey].p2pDonations += donation.amount;
        monthlyData[monthKey].totalAmount += donation.amount;
      }
    });

    statement.monthlySummary = monthlyData;

    // Generate statement ID
    const statementId = `STMT-${financialYear.replace('-', '')}-${userId.toString().slice(-6)}-${Date.now()}`;
    statement.statementId = statementId;
    statement.generatedAt = new Date().toISOString();

    res.json({
      status: "Success",
      message: "Statement generated successfully",
      statement
    });

  } catch (error) {
    console.error("Error generating statement:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to generate statement",
      error: error.message,
    });
  }
};

exports.getAvailableFinancialYears = async (req, res) => {
  try {
    const userId = req.user._id;

    // Get all orders for the user
    const orders = await Order.find({
      user: userId,
      paymentStatus: { $ne: "failed" }
    }).select('createdAt paymentType recurringDetails installmentDetails');

    // Get P2P donations for the user
    const goFundMeDonations = await GoFundMeDonation.find({
      donorEmail: req.user.email,
      paymentStatus: "completed"
    }).select('createdAt');

    // Collect all dates
    const allDates = [];

    // Add order dates
    orders.forEach(order => {
      allDates.push(order.createdAt);
      
      // Add recurring payment dates
      if (order.paymentType === 'recurring' && order.recurringDetails?.paymentHistory) {
        order.recurringDetails.paymentHistory.forEach(payment => {
          if (payment.status === 'succeeded') {
            allDates.push(payment.date);
          }
        });
      }
      
      // Add installment payment dates
      if (order.paymentType === 'installments' && order.installmentDetails?.installmentHistory) {
        order.installmentDetails.installmentHistory.forEach(installment => {
          if (installment.status === 'completed') {
            allDates.push(installment.date);
          }
        });
      }
    });

    // Add P2P donation dates
    goFundMeDonations.forEach(donation => {
      allDates.push(donation.createdAt);
    });

    // Extract unique financial years
    const financialYears = new Set();
    
    allDates.forEach(date => {
      const year = date.getFullYear();
      const month = date.getMonth(); // 0-11 (January = 0)
      
      // Financial year starts in July (month 6)
      let financialYear;
      if (month >= 6) { // July to December
        financialYear = `${year}-${year + 1}`;
      } else { // January to June
        financialYear = `${year - 1}-${year}`;
      }
      
      financialYears.add(financialYear);
    });

    // Convert to sorted array (newest first)
    const sortedYears = Array.from(financialYears).sort().reverse();

    res.json({
      status: "Success",
      financialYears: sortedYears,
      totalYears: sortedYears.length
    });

  } catch (error) {
    console.error("Error getting available financial years:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to get available financial years",
      error: error.message,
    });
  }
};

exports.downloadStatementPDF = async (req, res) => {
  try {
    const { financialYear } = req.query;
    const userId = req.user._id;

    // Validate financial year format
    if (!financialYear || !/^\d{4}-\d{4}$/.test(financialYear)) {
      return res.status(400).json({
        status: "Error",
        message: "Please provide a valid financial year in format YYYY-YYYY (e.g., 2023-2024)",
      });
    }

    const [startYear, endYear] = financialYear.split('-');
    
    // Validate that end year is start year + 1
    if (parseInt(endYear) !== parseInt(startYear) + 1) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid financial year format. End year must be start year + 1 (e.g., 2023-2024)",
      });
    }

    // Generate the statement data first
    const startDate = new Date(parseInt(startYear), 6, 1); // July 1st
    const endDate = new Date(parseInt(startYear) + 1, 5, 30, 23, 59, 59); // June 30th

    // Get all orders for the user in the financial year
    const orders = await Order.find({
      user: userId,
      createdAt: { $gte: startDate, $lte: endDate },
      paymentStatus: { $ne: "failed" }
    }).sort({ createdAt: 1 });

    // Get P2P donations for the user in the financial year
    const goFundMeDonations = await GoFundMeDonation.find({
      donorEmail: req.user.email,
      createdAt: { $gte: startDate, $lte: endDate },
      paymentStatus: "completed"
    }).populate('goFundMeId', 'title slug');

    // Check if user has any data for this financial year
    if (orders.length === 0 && goFundMeDonations.length === 0) {
      return res.status(404).json({
        status: "Error",
        message: "No donation data found for the specified financial year",
      });
    }

    // Initialize statement data (same logic as generateStatement)
    const statement = {
      financialYear,
      user: {
        name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
        email: req.user.email,
        userId: userId
      },
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      summary: {
        totalDonations: 0,
        totalAmount: 0,
        totalRecurringPayments: 0,
        totalInstallmentPayments: 0,
        totalOneTimePayments: 0,
        totalP2PDonations: 0,
        totalP2PAmount: 0
      },
      breakdown: {
        oneTimePayments: [],
        recurringPayments: [],
        installmentPayments: [],
        p2pDonations: []
      },
      monthlySummary: {},
      paymentMethods: {}
    };

    // Process regular orders (same logic as generateStatement)
    for (const order of orders) {
      const orderData = {
        donationId: order.donationId,
        paymentType: order.paymentType,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        lastPaymentDate: order.lastPaymentDate,
        donationType: order.donationType,
        items: order.items
      };

      let actualPayments = 0;
      let paymentHistory = [];

      if (order.paymentType === 'single') {
        if (order.paymentStatus === 'completed' || order.paymentStatus === 'succeeded') {
          actualPayments = order.totalAmount;
          paymentHistory.push({
            date: order.createdAt,
            amount: order.totalAmount,
            status: order.paymentStatus
          });
        }
      } else if (order.paymentType === 'recurring' && order.recurringDetails) {
        const recurringPayments = order.recurringDetails.paymentHistory || [];
        const yearPayments = recurringPayments.filter(payment => 
          payment.date >= startDate && payment.date <= endDate && payment.status === 'succeeded'
        );
        
        actualPayments = yearPayments.reduce((sum, payment) => sum + payment.amount, 0);
        paymentHistory = yearPayments.map(payment => ({
          date: payment.date,
          amount: payment.amount,
          status: payment.status,
          invoiceId: payment.invoiceId
        }));

        orderData.recurringDetails = {
          frequency: order.recurringDetails.frequency,
          amount: order.recurringDetails.amount,
          status: order.recurringDetails.status,
          totalPayments: order.recurringDetails.totalPayments
        };
      } else if (order.paymentType === 'installments' && order.installmentDetails) {
        const installmentPayments = order.installmentDetails.installmentHistory || [];
        const yearInstallments = installmentPayments.filter(installment => 
          installment.date >= startDate && installment.date <= endDate && installment.status === 'completed'
        );
        
        actualPayments = yearInstallments.reduce((sum, installment) => sum + installment.amount, 0);
        paymentHistory = yearInstallments.map(installment => ({
          date: installment.date,
          amount: installment.amount,
          status: installment.status,
          installmentNumber: installment.installmentNumber,
          transactionId: installment.transactionId
        }));

        orderData.installmentDetails = {
          numberOfInstallments: order.installmentDetails.numberOfInstallments,
          installmentAmount: order.installmentDetails.installmentAmount,
          installmentsPaid: order.installmentDetails.installmentsPaid,
          status: order.installmentDetails.status
        };
      }

      orderData.actualPayments = actualPayments;
      orderData.paymentHistory = paymentHistory;

      if (order.paymentType === 'single') {
        statement.breakdown.oneTimePayments.push(orderData);
        statement.summary.totalOneTimePayments += actualPayments;
      } else if (order.paymentType === 'recurring') {
        statement.breakdown.recurringPayments.push(orderData);
        statement.summary.totalRecurringPayments += actualPayments;
      } else if (order.paymentType === 'installments') {
        statement.breakdown.installmentPayments.push(orderData);
        statement.summary.totalInstallmentPayments += actualPayments;
      }

      if (!statement.paymentMethods[order.paymentMethod]) {
        statement.paymentMethods[order.paymentMethod] = 0;
      }
      statement.paymentMethods[order.paymentMethod] += actualPayments;
    }

    // Process P2P donations
    for (const donation of goFundMeDonations) {
      const donationData = {
        donationId: donation._id,
        campaignTitle: donation.goFundMeId.title,
        campaignSlug: donation.goFundMeId.slug,
        amount: donation.amount,
        netAmount: donation.netAmount,
        transactionFee: donation.transactionFee,
        paymentMethod: donation.paymentMethod,
        isAnonymous: donation.isAnonymous,
        message: donation.message,
        createdAt: donation.createdAt,
        donorName: donation.donorName
      };

      statement.breakdown.p2pDonations.push(donationData);
      statement.summary.totalP2PDonations += 1;
      statement.summary.totalP2PAmount += donation.amount;

      if (!statement.paymentMethods[donation.paymentMethod]) {
        statement.paymentMethods[donation.paymentMethod] = 0;
      }
      statement.paymentMethods[donation.paymentMethod] += donation.amount;
    }

    // Calculate totals
    statement.summary.totalDonations = 
      statement.breakdown.oneTimePayments.length +
      statement.breakdown.recurringPayments.length +
      statement.breakdown.installmentPayments.length +
      statement.breakdown.p2pDonations.length;

    statement.summary.totalAmount = 
      statement.summary.totalOneTimePayments +
      statement.summary.totalRecurringPayments +
      statement.summary.totalInstallmentPayments +
      statement.summary.totalP2PAmount;

    // Generate monthly summary
    const monthlyData = {};
    for (let month = 0; month < 12; month++) {
      const monthDate = new Date(startDate);
      monthDate.setMonth(startDate.getMonth() + month);
      const monthKey = monthDate.toISOString().slice(0, 7);
      monthlyData[monthKey] = {
        oneTimePayments: 0,
        recurringPayments: 0,
        installmentPayments: 0,
        p2pDonations: 0,
        totalAmount: 0
      };
    }

    [...statement.breakdown.oneTimePayments, ...statement.breakdown.recurringPayments, 
     ...statement.breakdown.installmentPayments].forEach(order => {
      order.paymentHistory.forEach(payment => {
        const monthKey = payment.date.toISOString().slice(0, 7);
        if (monthlyData[monthKey]) {
          if (order.paymentType === 'single') {
            monthlyData[monthKey].oneTimePayments += payment.amount;
          } else if (order.paymentType === 'recurring') {
            monthlyData[monthKey].recurringPayments += payment.amount;
          } else if (order.paymentType === 'installments') {
            monthlyData[monthKey].installmentPayments += payment.amount;
          }
          monthlyData[monthKey].totalAmount += payment.amount;
        }
      });
    });

    statement.breakdown.p2pDonations.forEach(donation => {
      const monthKey = donation.createdAt.toISOString().slice(0, 7);
      if (monthlyData[monthKey]) {
        monthlyData[monthKey].p2pDonations += donation.amount;
        monthlyData[monthKey].totalAmount += donation.amount;
      }
    });

    statement.monthlySummary = monthlyData;

    // Generate statement ID
    const statementId = `STMT-${financialYear.replace('-', '')}-${userId.toString().slice(-6)}-${Date.now()}`;
    statement.statementId = statementId;
    statement.generatedAt = new Date().toISOString();

    // Generate PDF
    const { filePath, fileName } = await generateStatementPDF(statement, req.user.email);

    // Send the PDF file
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Error sending PDF:", err);
        res.status(500).json({
          status: "Error",
          message: "Failed to download PDF",
          error: err.message,
        });
      }
      
      // Clean up the file after sending
      setTimeout(() => {
        const fs = require("fs");
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }, 5000); // Delete after 5 seconds
    });

  } catch (error) {
    console.error("Error generating PDF statement:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to generate PDF statement",
      error: error.message,
    });
  }
};

// @desc    Confirm payment for quick donation
// @route   POST /api/orders/confirm-payment
// @access  Public
exports.confirmPayment = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: "Payment intent ID is required",
      });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        success: false,
        message: "Payment not completed",
      });
    }

    // Find the order using the payment intent ID
    const order = await Order.findOne({
      "transactionDetails.stripePaymentIntentId": paymentIntentId,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Update order status
    order.paymentStatus = "completed";
    order.transactionDetails.stripeStatus = paymentIntent.status;
    await order.save();

    // Send receipt email
    try {
      await sendReceiptEmail(order);
    } catch (emailError) {
      console.error("Failed to send receipt email:", emailError);
    }

    res.json({
      success: true,
      message: "Payment confirmed successfully",
      order: {
        _id: order._id,
        donationId: order.donationId,
        paymentStatus: order.paymentStatus,
      },
    });
  } catch (error) {
    console.error("Error confirming payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Process order after successful payment
// @route   POST /api/orders/process-payment
// @access  Public
exports.processPayment = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: "Payment intent ID is required",
      });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        success: false,
        message: "Payment not completed",
      });
    }

    // Find the order using the payment intent ID
    const order = await Order.findOne({
      "transactionDetails.stripePaymentIntentId": paymentIntentId,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Check if order is already processed
    if (order.paymentStatus === "completed") {
      return res.json({
        success: true,
        message: "Order already processed",
        order: order,
        alreadyProcessed: true,
      });
    }

    // Update order status
    order.paymentStatus = "completed";
    order.transactionDetails.stripeStatus = paymentIntent.status;
    await order.save();

    // Send receipt email
    try {
      await sendReceiptEmail(order);
    } catch (emailError) {
      console.error("Failed to send receipt email:", emailError);
    }

    res.json({
      success: true,
      message: "Payment processed successfully",
      order: {
        _id: order._id,
        donationId: order.donationId,
        paymentStatus: order.paymentStatus,
        totalAmount: order.totalAmount,
      },
    });
  } catch (error) {
    console.error("Error processing payment:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get yearly donation statistics
// @route   GET /api/orders/yearly-stats
// @access  Private
exports.getYearlyStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const userEmail = req.user.email;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Parse query parameters
    const { year, paymentType, paymentStatus } = req.query;
    // If no year specified, don't filter by year (show all data)
    const targetYear = year ? parseInt(year) : null;


    // Get all orders for the user
    const orders = await Order.find({ user: userId });

    // Get all GoFundMe donations for the user
    const goFundMeDonations = await GoFundMeDonation.find({
      donorEmail: userEmail,
      paymentStatus: { $in: ["completed", "pending"] }
    });

    // Filter out failed orders
    const validOrders = orders.filter(
      (order) => order.paymentStatus !== "failed"
    );

    // Filter by year and payment type
    const filteredOrders = validOrders.filter((order) => {
      // If targetYear is specified, filter by year
      if (targetYear !== null) {
        const orderYear = new Date(order.createdAt).getFullYear();
        if (orderYear !== targetYear) return false;
      }
      
      if (paymentType && paymentType !== 'all') {
        if (paymentType === 'p2p') return false; // Regular orders are never P2P
        if (order.paymentType !== paymentType) return false;
      }
      
      if (paymentStatus && paymentStatus !== 'all') {
        if (order.paymentStatus !== paymentStatus) return false;
      }
      
      return true;
    });

    // Filter GoFundMe donations by year
    const filteredGoFundMeDonations = goFundMeDonations.filter((donation) => {
      // If targetYear is specified, filter by year
      if (targetYear !== null) {
        const donationYear = new Date(donation.createdAt).getFullYear();
        if (donationYear !== targetYear) return false;
      }
      
      if (paymentType && paymentType !== 'all' && paymentType !== 'p2p') {
        return false; // If filtering for non-P2P type, exclude P2P donations
      }
      
      if (paymentType === 'p2p') {
        // Only include P2P donations
        if (paymentStatus && paymentStatus !== 'all' && donation.paymentStatus !== paymentStatus) {
          return false;
        }
      } else if (paymentType && paymentType !== 'p2p') {
        return false; // If filtering for specific type (not P2P), exclude P2P donations
      }
      
      return true;
    });

    // Combine data for processing
    const allTransactions = [
      ...filteredOrders.map(order => ({
        type: 'order',
        createdAt: order.createdAt,
        paymentType: order.paymentType,
        paymentStatus: order.paymentStatus,
        amount: order.totalAmount,
        order
      })),
      ...filteredGoFundMeDonations.map(donation => ({
        type: 'gofundme',
        createdAt: donation.createdAt,
        paymentType: 'p2p',
        paymentStatus: donation.paymentStatus,
        amount: donation.amount,
        donation
      }))
    ];

    // Group by month
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    const monthlyData = {};

    // If specific year is requested, pre-populate months for that year
    if (targetYear !== null) {
      for (let month = 1; month <= 12; month++) {
        const monthKey = `${targetYear}-${String(month).padStart(2, "0")}`;
        const monthName = monthNames[month - 1];
        const displayMonth = `${monthName.substring(0, 3)} ${targetYear}`;
        
        monthlyData[monthKey] = {
          month: displayMonth,
          monthKey,
          amount: 0,
          count: 0
        };
      }
    }

    // Process transactions and assign to months
    for (const transaction of allTransactions) {
      const date = new Date(transaction.createdAt);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;
      
      // If month doesn't exist in monthlyData, create it
      if (!monthlyData[monthKey]) {
        const monthName = monthNames[month - 1];
        const displayMonth = `${monthName.substring(0, 3)} ${year}`;
        
        monthlyData[monthKey] = {
          month: displayMonth,
          monthKey,
          amount: 0,
          count: 0
        };
      }
      
      monthlyData[monthKey].amount += transaction.amount;
      monthlyData[monthKey].count += 1;
    }

    // Convert to array and sort by monthKey
    const monthlyStats = Object.values(monthlyData).sort((a, b) => 
      a.monthKey.localeCompare(b.monthKey)
    );

    // Calculate summary statistics
    const totalAmount = monthlyStats.reduce((sum, month) => sum + month.amount, 0);
    const totalCount = monthlyStats.reduce((sum, month) => sum + month.count, 0);
    const averageDonation = totalCount > 0 ? totalAmount / totalCount : 0;

    const yearlySummary = {
      totalAmount: Number(totalAmount.toFixed(2)),
      totalCount,
      averageDonation: Number(averageDonation.toFixed(2))
    };

    res.json({
      status: "Success",
      yearlySummary,
      monthlyStats: monthlyStats.map(month => ({
        month: month.month,
        monthKey: month.monthKey,
        amount: Number(month.amount.toFixed(2)),
        count: month.count
      }))
    });
  } catch (error) {
    console.error("Error getting yearly stats:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to get yearly statistics",
      error: error.message,
    });
  }
};
