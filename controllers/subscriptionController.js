const Order = require("../models/order");

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
          : subscription.installmentDetails.amount,
      frequency:
        subscription.paymentType === "recurring"
          ? subscription.recurringDetails.frequency
          : subscription.installmentDetails.frequency,
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

    // // Create log entry
    // await createLog("UPDATE", "SUBSCRIPTION", subscription._id, req.user, req, {
    //   action: "pause",
    //   duration: pauseDuration,
    // });

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

    subscription.paymentStatus = "active";

    // Update pause history
    if (subscription.pauseHistory?.length > 0) {
      subscription.pauseHistory[
        subscription.pauseHistory.length - 1
      ].actualEndDate = new Date();
    }

    await subscription.save();

    // // Create log entry
    // await createLog("UPDATE", "SUBSCRIPTION", subscription._id, req.user, req, {
    //   action: "resume",
    // });

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

    subscription.paymentStatus = "cancelled";
    subscription.cancellationDetails = {
      date: new Date(),
      reason: reason || "User requested cancellation",
      cancelledBy: req.user._id,
    };

    await subscription.save();

    // // Create log entry
    // await createLog("UPDATE", "SUBSCRIPTION", subscription._id, req.user, req, {
    //   action: "cancel",
    //   reason,
    // });

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

    if (subscription.paymentType === "recurring") {
      subscription.recurringDetails.amount = newAmount;
    } else {
      subscription.installmentDetails.amount = newAmount;
    }

    subscription.amountHistory = subscription.amountHistory || [];
    subscription.amountHistory.push({
      oldAmount: subscription.totalAmount,
      newAmount,
      date: new Date(),
    });

    subscription.totalAmount = newAmount;
    await subscription.save();

    // // Create log entry
    // await createLog("UPDATE", "SUBSCRIPTION", subscription._id, req.user, req, {
    //   action: "update_amount",
    //   oldAmount: subscription.totalAmount,
    //   newAmount,
    // });

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
  const frequency =
    subscription.paymentType === "recurring"
      ? subscription.recurringDetails.frequency
      : subscription.installmentDetails.frequency;

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
        throw new Error("Invalid frequency");
    }
  }

  return nextDate;
};

// Helper function to calculate remaining installments
const calculateRemainingInstallments = (subscription) => {
  if (!subscription.installmentDetails) return 0;

  const totalInstallments =
    subscription.installmentDetails.numberOfInstallments;
  const completedPayments = subscription.paymentHistory?.length || 0;

  return Math.max(0, totalInstallments - completedPayments);
};
