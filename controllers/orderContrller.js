// controllers/orderController.js
const Order = require("../models/order");
const User = require("../models/user");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
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
    } = req.body;

    console.log("Received order data:", req.body);

    // Validate required fields
    if (!items || !paymentType || !donorDetails) {
      return res.status(400).json({
        status: "Error",
        message: "Missing required fields",
      });
    }

    // Generate donation ID
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const randomNum = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    const donationId = `D${year}${month}${randomNum}`;

    // Validate recurring payment details
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

    // Validate installment payment details
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
    }

    // Create or update donor information if user exists
    const user = req.user;
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

    // Prepare recurring details if applicable
    let orderRecurringDetails = null;
    if (paymentType === "recurring") {
      orderRecurringDetails = {
        frequency: recurringDetails.frequency,
        amount: recurringDetails.amount,
        startDate: new Date(),
        status: "active",
        nextPaymentDate: calculateNextPaymentDate(
          new Date(),
          recurringDetails.frequency
        ),
        totalPayments: 0,
        paymentHistory: [],
      };
    }

    // Prepare installment details if applicable
    let orderInstallmentDetails = null;
    if (paymentType === "installments") {
      orderInstallmentDetails = {
        numberOfInstallments: installmentDetails.numberOfInstallments,
        installmentAmount: installmentDetails.installmentAmount,
        startDate: new Date(),
        status: "active",
        installmentsPaid: 0,
        nextInstallmentDate: new Date(),
        installmentHistory: [],
      };
    }

    // Create order with donationId
    const order = new Order({
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
      paymentMethod,
      paymentStatus: paymentMethod === "bank" ? "pending" : "processing",
      totalAmount,
      recurringDetails: orderRecurringDetails,
      installmentDetails: orderInstallmentDetails,
      transactionDetails: {},
    });

    // Attempt to save with retries in case of donationId collision
    let savedOrder = null;
    let retries = 3;

    while (retries > 0) {
      try {
        savedOrder = await order.save();
        break;
      } catch (error) {
        if (error.code === 11000 && error.keyPattern.donationId) {
          // Duplicate donationId, generate a new one and retry
          order.donationId = `D${year}${month}${Math.floor(
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

    // Process payment with Stripe if card is selected
    if (paymentMethod === "card" && stripePaymentMethodId) {
      try {
        // Handle different payment types
        if (paymentType === "single") {
          // Process one-time payment
          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(totalAmount * 100), // Convert to cents
            currency: "aud",
            payment_method: stripePaymentMethodId,
            confirm: true,
            description: `Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
            },
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: "never",
            },
          });

          // Update order with payment intent details
          savedOrder.transactionDetails = {
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
          };

          // Update payment status based on Stripe status
          if (paymentIntent.status === "succeeded") {
            savedOrder.paymentStatus = "completed";
          } else if (paymentIntent.status === "requires_action") {
            savedOrder.paymentStatus = "requires_action";
          }

          await savedOrder.save();
        } else if (paymentType === "recurring") {
          // IMPROVED PAYMENT METHOD HANDLING
          let customer;

          try {
            // First, try to retrieve the payment method
            const paymentMethod = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );

            // If it's already attached to a customer
            if (paymentMethod.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethod.customer}`
              );

              // Use that customer
              customer = await stripe.customers.retrieve(
                paymentMethod.customer
              );
              console.log(`Using existing customer ${customer.id}`);
            } else {
              // If it's not attached to any customer, create a new one
              customer = await stripe.customers.create({
                email: donorDetails.email,
                name: donorDetails.name,
                phone: donorDetails.phone,
              });

              console.log(`Created new customer ${customer.id}`);

              // Then attach the payment method to the customer
              await stripe.paymentMethods.attach(stripePaymentMethodId, {
                customer: customer.id,
              });

              console.log(
                `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
              );
            }

            // Set it as the default payment method
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

            // Special handling for the "already attached" error
            if (
              stripeError.code === "payment_method_in_use" ||
              stripeError.message.includes("already been attached")
            ) {
              try {
                console.log("Handling 'already attached' error");

                // Try to find the customer by looking up the payment method
                const paymentMethod = await stripe.paymentMethods.retrieve(
                  stripePaymentMethodId
                );

                if (paymentMethod.customer) {
                  // Use the customer this payment method is already attached to
                  customer = await stripe.customers.retrieve(
                    paymentMethod.customer
                  );
                  console.log(
                    `Using existing customer ${customer.id} that payment method is attached to`
                  );
                } else {
                  // This shouldn't happen if we got an "already attached" error, but just in case
                  throw new Error(
                    "Payment method is reported as already attached but no customer found"
                  );
                }
              } catch (secondError) {
                console.error("Error in special handling:", secondError);
                throw secondError;
              }
            } else {
              // For other types of errors, just pass them along
              throw stripeError;
            }
          }

          // Convert frequency to Stripe interval
          let interval;
          switch (recurringDetails.frequency) {
            case "daily": // Note: Stripe doesn't support daily, you might need a custom solution
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

          // First create the product
          const product = await stripe.products.create({
            name: "Recurring Donation",
            metadata: {
              donationId: savedOrder.donationId,
            },
          });

          console.log(`Created product for recurring donation: ${product.id}`);

          // Create the subscription with the product ID - MODIFIED to ensure immediate completion
          const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [
              {
                price_data: {
                  currency: "aud",
                  product: product.id,
                  unit_amount: Math.round(recurringDetails.amount * 100),
                  recurring: {
                    interval: interval,
                  },
                },
              },
            ],
            // Removed payment_behavior: "default_incomplete"
            payment_settings: {
              save_default_payment_method: "on_subscription",
              payment_method_types: ["card"],
            },
            default_payment_method: stripePaymentMethodId, // Explicitly set default payment method
            expand: ["latest_invoice.payment_intent"],
          });

          console.log(
            `Created subscription: ${subscription.id} for customer ${customer.id}, status: ${subscription.status}`
          );

          // Update order with subscription details
          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripeSubscriptionId: subscription.id,
            stripeStatus: subscription.status,
            clientSecret:
              subscription.latest_invoice.payment_intent?.client_secret,
          };

          // Set payment status based on subscription status
          if (subscription.status === "active") {
            savedOrder.paymentStatus = "completed";
          } else if (subscription.status === "incomplete") {
            savedOrder.paymentStatus = "requires_action";
          }

          await savedOrder.save();
        } else if (paymentType === "installments") {
          // IMPROVED PAYMENT METHOD HANDLING
          let customer;

          try {
            // First, try to retrieve the payment method
            const paymentMethod = await stripe.paymentMethods.retrieve(
              stripePaymentMethodId
            );

            // If it's already attached to a customer
            if (paymentMethod.customer) {
              console.log(
                `Payment method ${stripePaymentMethodId} is already attached to customer ${paymentMethod.customer}`
              );

              // Use that customer
              customer = await stripe.customers.retrieve(
                paymentMethod.customer
              );
              console.log(`Using existing customer ${customer.id}`);
            } else {
              // If it's not attached to any customer, create a new one
              customer = await stripe.customers.create({
                email: donorDetails.email,
                name: donorDetails.name,
                phone: donorDetails.phone,
              });

              console.log(`Created new customer ${customer.id}`);

              // Then attach the payment method to the customer
              await stripe.paymentMethods.attach(stripePaymentMethodId, {
                customer: customer.id,
              });

              console.log(
                `Attached payment method ${stripePaymentMethodId} to customer ${customer.id}`
              );
            }

            // Set it as the default payment method
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

            // Special handling for the "already attached" error
            if (
              stripeError.code === "payment_method_in_use" ||
              stripeError.message.includes("already been attached")
            ) {
              try {
                console.log("Handling 'already attached' error");

                // Try to find the customer by looking up the payment method
                const paymentMethod = await stripe.paymentMethods.retrieve(
                  stripePaymentMethodId
                );

                if (paymentMethod.customer) {
                  // Use the customer this payment method is already attached to
                  customer = await stripe.customers.retrieve(
                    paymentMethod.customer
                  );
                  console.log(
                    `Using existing customer ${customer.id} that payment method is attached to`
                  );
                } else {
                  // This shouldn't happen if we got an "already attached" error, but just in case
                  throw new Error(
                    "Payment method is reported as already attached but no customer found"
                  );
                }
              } catch (secondError) {
                console.error("Error in special handling:", secondError);
                throw secondError;
              }
            } else {
              // For other types of errors, just pass them along
              throw stripeError;
            }
          }

          // Process first installment - MODIFIED to match recurring improvement approach
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
            off_session: true, // Added to attempt immediate processing
            description: `Installment 1/${installmentDetails.numberOfInstallments} for Donation ${savedOrder.donationId}`,
            metadata: {
              donationId: savedOrder.donationId,
              orderId: savedOrder._id.toString(),
              installment: 1,
              totalInstallments: installmentDetails.numberOfInstallments,
            },
          });

          console.log(`Created first installment payment: ${paymentIntent.id}`);

          // Store customer ID for future installments
          savedOrder.transactionDetails = {
            stripeCustomerId: customer.id,
            stripePaymentIntentId: paymentIntent.id,
            stripeStatus: paymentIntent.status,
            clientSecret: paymentIntent.client_secret,
          };

          // Update installment details
          if (savedOrder.installmentDetails) {
            savedOrder.installmentDetails.installmentsPaid = 1;
            savedOrder.installmentDetails.nextInstallmentDate = new Date(
              Date.now() + 30 * 24 * 60 * 60 * 1000
            ); // 30 days from now

            // Add to payment history
            savedOrder.installmentDetails.installmentHistory.push({
              installmentNumber: 1,
              amount: installmentDetails.installmentAmount,
              date: new Date(),
              status:
                paymentIntent.status === "succeeded"
                  ? "completed"
                  : "processing",
              transactionId: paymentIntent.id,
            });
          }

          // Set payment status
          if (paymentIntent.status === "succeeded") {
            // For installments, we keep the order in "processing" until all installments are paid
            savedOrder.paymentStatus = "processing";
          } else if (paymentIntent.status === "requires_action") {
            savedOrder.paymentStatus = "requires_action";
          }

          await savedOrder.save();
        }
      } catch (stripeError) {
        console.error("Stripe payment error:", stripeError);

        // Update order status to failed
        savedOrder.paymentStatus = "failed";
        savedOrder.transactionDetails = {
          error: stripeError.message,
        };
        await savedOrder.save();

        return res.status(400).json({
          status: "Error",
          message: `Payment processing failed: ${stripeError.message}`,
          order: {
            _id: savedOrder._id,
            donationId: savedOrder.donationId,
          },
        });
      }
    }

    // Send response
    res.status(201).json({
      status: "Success",
      message: "Order created successfully",
      order: {
        _id: savedOrder._id,
        donationId: savedOrder.donationId,
        totalAmount: savedOrder.totalAmount,
        paymentStatus: savedOrder.paymentStatus,
        recurringDetails: orderRecurringDetails,
        installmentDetails: orderInstallmentDetails,
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
  }

  return nextDate;
};
