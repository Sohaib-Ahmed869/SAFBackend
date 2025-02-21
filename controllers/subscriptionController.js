// Updated subscription controller with Stripe integration
const Order = require("../models/order");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.getActiveSubscriptions = async (req, res) => {
  try {
    const activeSubscriptions = await Order.find({
      user: req.user._id,
      paymentType: { $in: ["recurring", "installments"] },
      paymentStatus: { $ne: "failed" },
      $or: [
        { "recurringDetails.endDate": { $gt: new Date() } },
        { "recurringDetails.endDate": null },
      ],
    }).sort({ createdAt: -1 });

    const formattedSubscriptions = activeSubscriptions.map((subscription) => ({
      id: subscription._id,
      cause: subscription.items[0]?.title,
      amount:
        subscription.paymentType === "recurring"
          ? subscription.recurringDetails.amount
          : subscription.installmentDetails.installmentAmount,
      frequency:
        subscription.paymentType === "recurring"
          ? subscription.recurringDetails.frequency
          : "monthly", // Installments are typically monthly
      startDate:
        subscription.paymentType === "recurring"
          ? subscription.recurringDetails.startDate
          : subscription.installmentDetails.startDate,
      nextPayment: calculateNextPaymentDate(subscription),
      status: subscription.paymentStatus,
      paymentMethod: subscription.paymentMethod,
      remainingInstallments:
        subscription.paymentType === "installments"
          ? calculateRemainingInstallments(subscription)
          : null,
      // Add Stripe subscription ID for recurring payments
      stripeSubscriptionId:
        subscription.paymentType === "recurring"
          ? subscription.transactionDetails?.stripeSubscriptionId
          : null,
      stripeCustomerId:
        subscription.transactionDetails?.stripeCustomerId || null,
    }));

    res.json({
      status: "Success",
      subscriptions: formattedSubscriptions,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch active subscriptions",
      error: error.message,
    });
  }
};

exports.pauseSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { pauseDuration } = req.body; // Duration in days

    const subscription = await Order.findOne({
      _id: subscriptionId,
      user: req.user._id,
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    // Update subscription in Stripe if it's a recurring payment with Stripe
    if (
      subscription.paymentType === "recurring" &&
      subscription.paymentMethod === "card" &&
      subscription.transactionDetails?.stripeSubscriptionId
    ) {
      try {
        // Calculate pause end date
        const pauseEndDate = new Date();
        pauseEndDate.setDate(pauseEndDate.getDate() + pauseDuration);

        // Pause subscription in Stripe by updating to pause collection mode
        await stripe.subscriptions.update(
          subscription.transactionDetails.stripeSubscriptionId,
          {
            pause_collection: {
              behavior: "mark_uncollectible", // or 'keep_as_draft' based on your business logic
              resumes_at: Math.floor(pauseEndDate.getTime() / 1000), // Unix timestamp
            },
          }
        );

        console.log(
          `Paused Stripe subscription: ${subscription.transactionDetails.stripeSubscriptionId}`
        );
      } catch (stripeError) {
        console.error("Stripe subscription pause error:", stripeError);
        return res.status(400).json({
          status: "Error",
          message: `Failed to pause subscription in Stripe: ${stripeError.message}`,
        });
      }
    }

    // Update local subscription record
    subscription.paymentStatus = "paused";

    // Calculate new dates based on pause duration
    const pauseEndDate = new Date();
    pauseEndDate.setDate(pauseEndDate.getDate() + pauseDuration);

    if (subscription.paymentType === "recurring") {
      subscription.recurringDetails.startDate = new Date(
        subscription.recurringDetails.startDate.getTime() +
          pauseDuration * 24 * 60 * 60 * 1000
      );
    }

    // Add pause details
    subscription.pauseHistory = subscription.pauseHistory || [];
    subscription.pauseHistory.push({
      startDate: new Date(),
      endDate: pauseEndDate,
      reason: req.body.reason || "User requested pause",
    });

    await subscription.save();

    res.json({
      status: "Success",
      message: "Subscription paused successfully",
      subscription,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error",
      message: "Failed to pause subscription",
      error: error.message,
    });
  }
};

exports.resumeSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const subscription = await Order.findOne({
      _id: subscriptionId,
      user: req.user._id,
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    // Update subscription in Stripe if it's a recurring payment with Stripe
    if (
      subscription.paymentType === "recurring" &&
      subscription.paymentMethod === "card" &&
      subscription.transactionDetails?.stripeSubscriptionId
    ) {
      try {
        // Resume subscription in Stripe by removing the pause collection
        await stripe.subscriptions.update(
          subscription.transactionDetails.stripeSubscriptionId,
          {
            pause_collection: "", // Empty string removes the pause
          }
        );

        console.log(
          `Resumed Stripe subscription: ${subscription.transactionDetails.stripeSubscriptionId}`
        );
      } catch (stripeError) {
        console.error("Stripe subscription resume error:", stripeError);
        return res.status(400).json({
          status: "Error",
          message: `Failed to resume subscription in Stripe: ${stripeError.message}`,
        });
      }
    }

    // Update local subscription record
    subscription.paymentStatus = "active";

    // Update pause history
    if (subscription.pauseHistory?.length > 0) {
      subscription.pauseHistory[
        subscription.pauseHistory.length - 1
      ].actualEndDate = new Date();
    }

    await subscription.save();

    res.json({
      status: "Success",
      message: "Subscription resumed successfully",
      subscription,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error",
      message: "Failed to resume subscription",
      error: error.message,
    });
  }
};

exports.cancelSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { reason } = req.body;

    const subscription = await Order.findOne({
      _id: subscriptionId,
      user: req.user._id,
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    // Cancel subscription in Stripe if it's a recurring payment with Stripe
    if (
      subscription.paymentType === "recurring" &&
      subscription.paymentMethod === "card" &&
      subscription.transactionDetails?.stripeSubscriptionId
    ) {
      try {
        // Cancel subscription in Stripe
        await stripe.subscriptions.cancel(
          subscription.transactionDetails.stripeSubscriptionId
        );

        console.log(
          `Cancelled Stripe subscription: ${subscription.transactionDetails.stripeSubscriptionId}`
        );
      } catch (stripeError) {
        console.error("Stripe subscription cancellation error:", stripeError);
        return res.status(400).json({
          status: "Error",
          message: `Failed to cancel subscription in Stripe: ${stripeError.message}`,
        });
      }
    }

    // Update local subscription record
    subscription.paymentStatus = "cancelled";
    subscription.cancellationDetails = {
      date: new Date(),
      reason: reason || "User requested cancellation",
      cancelledBy: req.user._id,
    };

    await subscription.save();

    res.json({
      status: "Success",
      message: "Subscription cancelled successfully",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to cancel subscription",
      error: error.message,
    });
  }
};

exports.updateSubscriptionAmount = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { newAmount } = req.body;

    const subscription = await Order.findOne({
      _id: subscriptionId,
      user: req.user._id,
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    // Update amount in Stripe if it's a recurring payment with Stripe
    if (
      subscription.paymentType === "recurring" &&
      subscription.paymentMethod === "card" &&
      subscription.transactionDetails?.stripeSubscriptionId
    ) {
      try {
        // Get the current subscription from Stripe
        const stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.transactionDetails.stripeSubscriptionId
        );

        if (!stripeSubscription) {
          throw new Error("Subscription not found in Stripe");
        }

        // Get the subscription item ID (usually there's only one item)
        const subscriptionItemId = stripeSubscription.items.data[0].id;

        // Create a new price with the updated amount
        const newPrice = await stripe.prices.create({
          currency: "aud",
          unit_amount: Math.round(newAmount * 100), // Convert to cents
          recurring: {
            interval:
              subscription.recurringDetails.frequency === "monthly"
                ? "month"
                : subscription.recurringDetails.frequency === "yearly"
                ? "year"
                : subscription.recurringDetails.frequency === "weekly"
                ? "week"
                : "month",
          },
          product: stripeSubscription.items.data[0].price.product,
        });

        // Update subscription with the new price
        await stripe.subscriptions.update(
          subscription.transactionDetails.stripeSubscriptionId,
          {
            items: [
              {
                id: subscriptionItemId,
                price: newPrice.id,
              },
            ],
          }
        );

        console.log(
          `Updated Stripe subscription amount: ${subscription.transactionDetails.stripeSubscriptionId}`
        );
      } catch (stripeError) {
        console.error("Stripe subscription update error:", stripeError);
        return res.status(400).json({
          status: "Error",
          message: `Failed to update subscription amount in Stripe: ${stripeError.message}`,
        });
      }
    }

    // Update local subscription record
    if (subscription.paymentType === "recurring") {
      subscription.recurringDetails.amount = newAmount;
    } else if (subscription.paymentType === "installments") {
      subscription.installmentDetails.installmentAmount = newAmount;
    }

    subscription.amountHistory = subscription.amountHistory || [];
    subscription.amountHistory.push({
      oldAmount: subscription.totalAmount,
      newAmount,
      date: new Date(),
    });

    subscription.totalAmount = newAmount;
    await subscription.save();

    res.json({
      status: "Success",
      message: "Subscription amount updated successfully",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update subscription amount",
      error: error.message,
    });
  }
};

// Helper function to calculate next payment date
const calculateNextPaymentDate = (subscription) => {
  const today = new Date();
  let frequency = "monthly"; // Default

  if (subscription.paymentType === "recurring") {
    frequency = subscription.recurringDetails.frequency;
  } else if (
    subscription.installmentDetails &&
    subscription.installmentDetails.frequency
  ) {
    frequency = subscription.installmentDetails.frequency;
  }

  let nextDate = new Date(
    subscription.lastPaymentDate || subscription.createdAt
  );

  while (nextDate <= today) {
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
        nextDate.setMonth(nextDate.getMonth() + 1); // Default to monthly
    }
  }

  return nextDate;
};

// Helper function to calculate remaining installments
const calculateRemainingInstallments = (subscription) => {
  if (!subscription.installmentDetails) return 0;

  const totalInstallments =
    subscription.installmentDetails.numberOfInstallments;
  const completedPayments =
    subscription.installmentDetails.installmentsPaid || 0;

  return Math.max(0, totalInstallments - completedPayments);
};

// Get subscription by ID endpoint
exports.getSubscriptionById = async (req, res) => {
  try {
    const subscription = await Order.findOne({
      _id: req.params.subscriptionId,
      user: req.user._id,
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    res.json({
      status: "Success",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscription",
      error: error.message,
    });
  }
};

// Stripe webhook handler
exports.handleStripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(
      req.rawBody, // You need to configure your Express app to provide raw body
      signature,
      endpointSecret
    );
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle different event types
  try {
    switch (event.type) {
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;
      // Add other event types as needed
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error(`Error processing webhook: ${error.message}`);
    res.status(500).send(`Webhook processing error: ${error.message}`);
  }
};

// Handler for successful invoice payment
async function handleInvoicePaymentSucceeded(invoice) {
  try {
    // Find the subscription in our database
    if (invoice.subscription) {
      const order = await Order.findOne({
        "transactionDetails.stripeSubscriptionId": invoice.subscription,
      });

      if (order) {
        // Update payment history
        if (order.paymentType === "recurring" && order.recurringDetails) {
          order.recurringDetails.totalPayments =
            (order.recurringDetails.totalPayments || 0) + 1;
          order.recurringDetails.paymentHistory =
            order.recurringDetails.paymentHistory || [];
          order.recurringDetails.paymentHistory.push({
            date: new Date(),
            amount: invoice.amount_paid / 100, // Convert from cents
            invoiceId: invoice.id,
            status: "succeeded",
          });

          // Update next payment date
          order.recurringDetails.nextPaymentDate = calculateNextPaymentDate(
            new Date(),
            order.recurringDetails.frequency
          );
        } else if (
          order.paymentType === "installments" &&
          order.installmentDetails
        ) {
          order.installmentDetails.installmentsPaid =
            (order.installmentDetails.installmentsPaid || 0) + 1;
          order.installmentDetails.installmentHistory =
            order.installmentDetails.installmentHistory || [];
          order.installmentDetails.installmentHistory.push({
            installmentNumber: order.installmentDetails.installmentsPaid || 0,
            date: new Date(),
            amount: invoice.amount_paid / 100, // Convert from cents
            invoiceId: invoice.id,
            status: "completed",
          });

          // Check if all installments are paid
          if (
            order.installmentDetails.installmentsPaid >=
            order.installmentDetails.numberOfInstallments
          ) {
            order.paymentStatus = "completed";
          } else {
            // Update next installment date (assuming monthly)
            order.installmentDetails.nextInstallmentDate = new Date();
            order.installmentDetails.nextInstallmentDate.setMonth(
              order.installmentDetails.nextInstallmentDate.getMonth() + 1
            );
          }
        }

        // Make sure status reflects active payment
        if (
          order.paymentStatus === "requires_action" ||
          order.paymentStatus === "processing"
        ) {
          order.paymentStatus = "active";
        }

        await order.save();
        console.log(
          `Updated order ${order._id} with successful payment for invoice ${invoice.id}`
        );
      } else {
        console.log(`No order found for subscription ${invoice.subscription}`);
      }
    }
  } catch (error) {
    console.error("Error handling invoice.payment_succeeded:", error);
  }
}

// Handler for failed invoice payment
async function handleInvoicePaymentFailed(invoice) {
  try {
    if (invoice.subscription) {
      const order = await Order.findOne({
        "transactionDetails.stripeSubscriptionId": invoice.subscription,
      });

      if (order) {
        // Update status and add to payment history
        if (order.paymentType === "recurring" && order.recurringDetails) {
          order.recurringDetails.paymentHistory =
            order.recurringDetails.paymentHistory || [];
          order.recurringDetails.paymentHistory.push({
            date: new Date(),
            amount: invoice.amount_due / 100, // Convert from cents
            invoiceId: invoice.id,
            status: "failed",
            failureReason:
              invoice.last_payment_error?.message || "Unknown error",
          });
        } else if (
          order.paymentType === "installments" &&
          order.installmentDetails
        ) {
          order.installmentDetails.installmentHistory =
            order.installmentDetails.installmentHistory || [];
          order.installmentDetails.installmentHistory.push({
            installmentNumber:
              (order.installmentDetails.installmentsPaid || 0) + 1,
            date: new Date(),
            amount: invoice.amount_due / 100, // Convert from cents
            invoiceId: invoice.id,
            status: "failed",
            failureReason:
              invoice.last_payment_error?.message || "Unknown error",
          });
        }

        // Only set to failed after multiple attempts
        if (invoice.attempt_count > 2) {
          order.paymentStatus = "failed";
        }

        await order.save();
        console.log(
          `Updated order ${order._id} with failed payment for invoice ${invoice.id}`
        );
      } else {
        console.log(`No order found for subscription ${invoice.subscription}`);
      }
    }
  } catch (error) {
    console.error("Error handling invoice.payment_failed:", error);
  }
}

// Handler for subscription updates
async function handleSubscriptionUpdated(subscription) {
  try {
    const order = await Order.findOne({
      "transactionDetails.stripeSubscriptionId": subscription.id,
    });

    if (order) {
      // Update status based on Stripe subscription status
      switch (subscription.status) {
        case "active":
          order.paymentStatus = "active";
          break;
        case "past_due":
          order.paymentStatus = "past_due";
          break;
        case "unpaid":
          order.paymentStatus = "failed";
          break;
        case "canceled":
          order.paymentStatus = "cancelled";
          break;
        case "paused":
          order.paymentStatus = "paused";
          break;
        default:
          // No change
          break;
      }

      // Update the transaction details with the latest Stripe data
      order.transactionDetails = {
        ...order.transactionDetails,
        stripeStatus: subscription.status,
        stripeCancelAt: subscription.cancel_at
          ? new Date(subscription.cancel_at * 1000)
          : null,
        stripePauseCollection: subscription.pause_collection
          ? {
              behavior: subscription.pause_collection.behavior,
              resumesAt: subscription.pause_collection.resumes_at
                ? new Date(subscription.pause_collection.resumes_at * 1000)
                : null,
            }
          : null,
      };

      await order.save();
      console.log(
        `Updated order ${order._id} with subscription changes from Stripe`
      );
    } else {
      console.log(`No order found for subscription ${subscription.id}`);
    }
  } catch (error) {
    console.error("Error handling customer.subscription.updated:", error);
  }
}

// Handler for subscription deletion
async function handleSubscriptionDeleted(subscription) {
  try {
    const order = await Order.findOne({
      "transactionDetails.stripeSubscriptionId": subscription.id,
    });

    if (order) {
      order.paymentStatus = "cancelled";
      order.cancellationDetails = order.cancellationDetails || {};
      order.cancellationDetails.date = new Date();
      order.cancellationDetails.reason = "Subscription deleted in Stripe";
      order.transactionDetails.stripeStatus = "canceled";

      await order.save();
      console.log(
        `Marked order ${order._id} as cancelled due to Stripe subscription deletion`
      );
    } else {
      console.log(`No order found for deleted subscription ${subscription.id}`);
    }
  } catch (error) {
    console.error("Error handling customer.subscription.deleted:", error);
  }
}

exports.retryPayment = async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const subscription = await Order.findOne({
      _id: subscriptionId,
      user: req.user._id,
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    // Check if this is a Stripe subscription with payment issues
    if (
      subscription.paymentMethod !== "card" ||
      !subscription.transactionDetails?.stripeSubscriptionId ||
      (subscription.paymentStatus !== "past_due" &&
        subscription.paymentStatus !== "failed")
    ) {
      return res.status(400).json({
        status: "Error",
        message:
          "This subscription doesn't have failed payments to retry or isn't managed by Stripe",
      });
    }

    // Get the Stripe subscription
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.transactionDetails.stripeSubscriptionId
    );

    if (!stripeSubscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found in Stripe",
      });
    }

    // Find the latest unpaid invoice
    const invoices = await stripe.invoices.list({
      subscription: stripeSubscription.id,
      status: "open",
      limit: 1,
    });

    let retryResult;

    if (invoices.data.length > 0) {
      // Retry the latest failed invoice
      retryResult = await stripe.invoices.pay(invoices.data[0].id);
    } else {
      // If no open invoice exists, check for past due ones
      const pastDueInvoices = await stripe.invoices.list({
        subscription: stripeSubscription.id,
        status: "past_due",
        limit: 1,
      });

      if (pastDueInvoices.data.length > 0) {
        retryResult = await stripe.invoices.pay(pastDueInvoices.data[0].id);
      } else {
        // As a fallback, create a new invoice and pay it immediately
        const invoice = await stripe.invoices.create({
          customer: stripeSubscription.customer,
          subscription: stripeSubscription.id,
          auto_advance: false, // Don't finalize the invoice yet
        });

        // Finalize the invoice
        await stripe.invoices.finalizeInvoice(invoice.id);

        // Pay the invoice
        retryResult = await stripe.invoices.pay(invoice.id);
      }
    }

    // Update local subscription record
    if (retryResult.status === "paid") {
      subscription.paymentStatus = "active";

      // Add to payment history
      if (
        subscription.paymentType === "recurring" &&
        subscription.recurringDetails
      ) {
        subscription.recurringDetails.paymentHistory =
          subscription.recurringDetails.paymentHistory || [];
        subscription.recurringDetails.paymentHistory.push({
          date: new Date(),
          amount: retryResult.amount_paid / 100, // Convert from cents
          invoiceId: retryResult.id,
          status: "succeeded",
        });

        // Update next payment date
        subscription.recurringDetails.nextPaymentDate =
          calculateNextPaymentDate(
            new Date(),
            subscription.recurringDetails.frequency
          );
      }

      await subscription.save();

      return res.json({
        status: "Success",
        message: "Payment processed successfully",
        paymentStatus: subscription.paymentStatus,
      });
    } else {
      return res.status(400).json({
        status: "Error",
        message: "Payment retry initiated but not completed",
        stripeStatus: retryResult.status,
      });
    }
  } catch (error) {
    console.error("Retry payment error:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to retry payment",
      error: error.message,
    });
  }
};
