// services/subscriptionScheduler.js

const Order = require("../models/order");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cron = require("node-cron");

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
          // Otherwise, check for other statuses
          else {
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
