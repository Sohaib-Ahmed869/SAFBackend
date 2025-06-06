// services/subscriptionScheduler.js

const Order = require("../models/order");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cron = require("node-cron");

/**
 * Sync payment history for a subscription with Stripe
 */
const syncSubscriptionPaymentHistory = async (subscription) => {
  try {
    const subscriptionId = subscription.transactionDetails.stripeSubscriptionId;

    // Get all paid invoices for this subscription from Stripe
    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      status: "paid",
      limit: 100,
    });

    // Get existing payment history invoice IDs
    const existingInvoiceIds = new Set(
      (subscription.recurringDetails.paymentHistory || [])
        .map((p) => p.invoiceId)
        .filter((id) => id)
    );

    let newPaymentsAdded = 0;

    // Process each invoice from Stripe
    for (const invoice of invoices.data) {
      // Skip if we already have this payment recorded
      if (existingInvoiceIds.has(invoice.id)) {
        continue;
      }

      // Initialize payment history if it doesn't exist
      if (!subscription.recurringDetails.paymentHistory) {
        subscription.recurringDetails.paymentHistory = [];
      }

      // Add the payment to history
      subscription.recurringDetails.paymentHistory.push({
        date: new Date(invoice.status_transitions.paid_at * 1000),
        amount: invoice.amount_paid / 100, // Convert from cents
        invoiceId: invoice.id,
        status: "succeeded",
      });

      newPaymentsAdded++;
    }

    if (newPaymentsAdded > 0) {
      // Update totals
      const successfulPayments =
        subscription.recurringDetails.paymentHistory.filter(
          (p) => p.status === "succeeded"
        );

      subscription.recurringDetails.totalPayments = successfulPayments.length;

      // Update last payment date
      if (successfulPayments.length > 0) {
        const latestPayment = successfulPayments.reduce((latest, current) =>
          new Date(current.date) > new Date(latest.date) ? current : latest
        );
        subscription.recurringDetails.lastPaymentDate = latestPayment.date;
      }

      console.log(
        `Added ${newPaymentsAdded} new payments for subscription ${subscription.donationId}`
      );
    }

    return newPaymentsAdded;
  } catch (error) {
    console.error(
      `Error syncing payment history for subscription ${subscription.donationId}:`,
      error
    );
    return 0;
  }
};

/**
 * Scheduled task to sync subscription statuses with Stripe and update accordingly
 */
const scheduleSubscriptionChecks = () => {
  // Run every minute (adjust frequency as needed for production)
  cron.schedule("* * * * *", async () => {
    try {
      console.log(
        `[${new Date().toISOString()}] Running subscription sync with Stripe...`
      );

      // Find ALL recurring subscriptions with Stripe subscription IDs
      // Including those already marked as "cancelled" in our system
      const subscriptions = await Order.find({
        paymentType: "recurring",
        paymentStatus: { $nin: ["ended"] }, // Only exclude "ended" subscriptions
        "transactionDetails.stripeSubscriptionId": { $exists: true, $ne: null },
      });

      console.log(
        `Found ${subscriptions.length} subscriptions to check with Stripe`
      );

      // Check each subscription with Stripe
      for (const subscription of subscriptions) {
        try {
          // Get current status from Stripe
          const stripeSubscription = await stripe.subscriptions.retrieve(
            subscription.transactionDetails.stripeSubscriptionId
          );

          // SYNC PAYMENT HISTORY - This is the key addition!
          await syncSubscriptionPaymentHistory(subscription);

          console.log(`Stripe subscription data for ${subscription._id}:`);

          const now = new Date();

          // Check specifically for ended_at in the Stripe response
          const hasEndedAt = !!stripeSubscription.ended_at;
          // Check specifically for cancel_at in the Stripe response (scheduled end date)
          const hasCancelAt = !!stripeSubscription.cancel_at;
          // Check if either date is in the past
          const endedAtDate = hasEndedAt
            ? new Date(stripeSubscription.ended_at * 1000)
            : null;
          const cancelAtDate = hasCancelAt
            ? new Date(stripeSubscription.cancel_at * 1000)
            : null;

          // Check if recurring end date in our DB has passed
          const dbEndDatePassed =
            subscription.recurringDetails &&
            subscription.recurringDetails.endDate &&
            new Date(subscription.recurringDetails.endDate) <= now;

          let newStatus = subscription.paymentStatus; // Default to current status

          // Log all the conditions for debugging
          console.log(`Subscription ${subscription._id}:
            - Current status in our DB: ${subscription.paymentStatus}
            - Stripe status: ${stripeSubscription.status}
            - Has ended_at: ${hasEndedAt} (${endedAtDate})
            - Has cancel_at: ${hasCancelAt} (${cancelAtDate})
            - DB end date passed: ${dbEndDatePassed}
          `);

          // UPDATED PRIORITY DECISION LOGIC:

          // First, always check if Stripe shows the subscription as cancelled
          if (stripeSubscription.status === "canceled") {
            newStatus = "cancelled";
            console.log(
              `Subscription ${subscription._id} is marked as canceled in Stripe, setting to cancelled`
            );
          }
          // Otherwise, check for other statuses, but preserve pending_cancellation
          else {
            // Skip status update if subscription is pending cancellation
            if (subscription.paymentStatus === "pending_cancellation") {
              console.log(
                `Subscription ${subscription._id} is pending cancellation, preserving status`
              );
              // Keep the current pending_cancellation status
            } else {
              switch (stripeSubscription.status) {
                case "active":
                  newStatus = "active";
                  break;
                case "past_due":
                  newStatus = "past_due";
                  break;
                case "unpaid":
                  newStatus = "failed";
                  break;
                case "completed":
                  newStatus = "ended";
                  break;
                // No default case - we'll keep the current status if no match
              }
            }
          }

          // Also check if DB end date has passed but Stripe doesn't show it as cancelled
          // This handles subscriptions that expire naturally without being cancelled
          if (dbEndDatePassed && stripeSubscription.status !== "canceled") {
            newStatus = "ended";
            console.log(
              `Subscription ${subscription._id} has passed its DB end date and is not canceled in Stripe, marking as ended`
            );
          }

          // Update if status has changed
          if (newStatus !== subscription.paymentStatus) {
            console.log(
              `Updating subscription ${subscription._id} status from ${subscription.paymentStatus} to ${newStatus}`
            );

            subscription.paymentStatus = newStatus;
            subscription.transactionDetails = {
              ...subscription.transactionDetails,
              stripeStatus: stripeSubscription.status,
              lastSyncedAt: new Date(),
            };

            // Store end date information from Stripe if available
            if (hasEndedAt) {
              subscription.transactionDetails.stripeEndedAt = endedAtDate;
            }
            if (hasCancelAt) {
              subscription.transactionDetails.stripeCancelAt = cancelAtDate;
            }

            await subscription.save();
            console.log(
              `Successfully updated subscription ${subscription._id}`
            );
          } else {
            // Even if status didn't change, we might have updated payment history, so save
            await subscription.save();
            console.log(
              `No status change needed for subscription ${subscription._id}`
            );
          }
        } catch (error) {
          // Handle case where subscription might have been deleted in Stripe
          if (error.code === "resource_missing") {
            console.log(
              `Subscription ${subscription.transactionDetails.stripeSubscriptionId} not found in Stripe, marking as ended`
            );
            subscription.paymentStatus = "ended";
            subscription.transactionDetails = {
              ...subscription.transactionDetails,
              stripeStatus: "deleted",
              lastSyncedAt: new Date(),
            };
            await subscription.save();
          } else {
            console.error(
              `Error checking subscription ${subscription._id} with Stripe:`,
              error
            );
          }
        }
      }

      // Also check for subscriptions that have local end dates but no Stripe ID
      const now = new Date();
      const localExpiredSubscriptions = await Order.find({
        paymentType: "recurring",
        paymentStatus: { $nin: ["ended"] },
        "transactionDetails.stripeSubscriptionId": { $exists: false },
        "recurringDetails.endDate": { $lt: now, $ne: null },
      });

      console.log(
        `Found ${localExpiredSubscriptions.length} locally expired subscriptions`
      );

      for (const subscription of localExpiredSubscriptions) {
        subscription.paymentStatus = "ended";
        await subscription.save();
        console.log(
          `Updated local subscription ${subscription._id} to ended status`
        );
      }

      console.log(
        `[${new Date().toISOString()}] Completed subscription sync with Stripe`
      );
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error in subscription sync:`,
        error
      );
    }
  });

  console.log(
    `[${new Date().toISOString()}] Subscription sync scheduler initialized`
  );
};

module.exports = { scheduleSubscriptionChecks };
