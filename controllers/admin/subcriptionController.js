// controllers/admin/subscriptionController.js
const Order = require("../../models/order");

// Send email when admin approves a cancellation request
const sendCancellationApprovalEmail = async (subscription) => {
  try {
    const { sendEmail } = require("../../services/emailUtil");
    const User = require("../../models/user");
    
    // Get user from the subscription
    const user = await User.findById(subscription.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for subscription:", subscription._id);
      return;
    }

    console.log("Attempting to send cancellation approval email to:", user.email);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Subscription Cancellation Approved</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We are writing to confirm that your request to cancel your recurring donation has been approved.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Subscription Details:</h3>
          <p><strong>Amount:</strong> $${subscription.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${subscription.recurringDetails.frequency}</p>
          <p><strong>Cancellation Date:</strong> ${new Date().toLocaleDateString()}</p>
        </div>

        <p>Thank you for your generous support. We hope you will consider supporting our cause again in the future.</p>
        
        <p>If you have any questions, please don't hesitate to contact us.</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Subscription Cancellation Approved - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send cancellation approval email:", result.error);
    } else {
      console.log("Cancellation approval email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending cancellation approval email:", error);
  }
};

// Send email when admin denies a cancellation request
const sendCancellationDenialEmail = async (subscription) => {
  try {
    const { sendEmail } = require("../../services/emailUtil");
    const User = require("../../models/user");
    
    // Get user from the subscription
    const user = await User.findById(subscription.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for subscription:", subscription._id);
      return;
    }

    console.log("Attempting to send cancellation denial email to:", user.email);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #dc2626;">Subscription Cancellation Request Denied</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We are writing to inform you that your request to cancel your recurring donation could not be processed at this time.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Subscription Details:</h3>
          <p><strong>Amount:</strong> $${subscription.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${subscription.recurringDetails.frequency}</p>
        </div>

        <p>If you have any questions or would like to discuss this further, please contact us at info@ShahidAfridiFoundation.org.au.</p>
        
        <p>Thank you for your continued support.</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Subscription Cancellation Request Update - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send cancellation denial email:", result.error);
    } else {
      console.log("Cancellation denial email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending cancellation denial email:", error);
  }
};

// Approve a subscription cancellation request
exports.approveCancellationRequest = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Find the subscription with pending cancellation status
    const subscription = await Order.findOne({
      _id: subscriptionId,
      paymentStatus: "pending_cancellation",
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Pending cancellation request not found",
      });
    }

    // If this is a Stripe subscription, cancel it in Stripe
    if (
      subscription.paymentType === "recurring" &&
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
    if (subscription.cancellationDetails) {
      subscription.cancellationDetails.status = "approved";
      subscription.cancellationDetails.approvedBy = req.user._id;
      subscription.cancellationDetails.approvalDate = new Date();
    }

    await subscription.save();

    // Send email notification to the user
    await sendCancellationApprovalEmail(subscription);

    res.json({
      status: "Success",
      message: "Subscription cancellation request approved",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to approve cancellation request",
      error: error.message,
    });
  }
};

// Deny a subscription cancellation request
exports.denyCancellationRequest = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { reason } = req.body;

    // Find the subscription with pending cancellation status
    const subscription = await Order.findOne({
      _id: subscriptionId,
      paymentStatus: "pending_cancellation",
    });

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Pending cancellation request not found",
      });
    }

    // Update subscription record
    subscription.paymentStatus = "active"; // Revert back to active
    if (subscription.cancellationDetails) {
      subscription.cancellationDetails.status = "denied";
      subscription.cancellationDetails.deniedBy = req.user._id;
      subscription.cancellationDetails.denialDate = new Date();
      subscription.cancellationDetails.denialReason = reason || "Request denied by administrator";
    }

    await subscription.save();

    // Send email notification to the user
    await sendCancellationDenialEmail(subscription);

    res.json({
      status: "Success",
      message: "Subscription cancellation request denied",
      subscription,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to deny cancellation request",
      error: error.message,
    });
  }
};

// Get all pending cancellation requests
exports.getPendingCancellationRequests = async (req, res) => {
  try {
    const pendingRequests = await Order.find({
      paymentStatus: "pending_cancellation",
    }).populate("user", "name email");

    res.json({
      status: "Success",
      count: pendingRequests.length,
      pendingRequests,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch pending cancellation requests",
      error: error.message,
    });
  }
};

// Get Dashboard Stats
exports.getDashboardStats = async (req, res) => {
  try {
    // Get active subscriptions and MRR
    const subscriptionStats = await Order.aggregate([
      {
        $match: {
          paymentType: "recurring",
          paymentStatus: "active",
        },
      },
      {
        $group: {
          _id: null,
          activeSubscriptions: { $sum: 1 },
          monthlyRecurringRevenue: {
            $sum: {
              $cond: [
                { $eq: ["$recurringDetails.frequency", "monthly"] },
                "$recurringDetails.amount",
                {
                  $cond: [
                    { $eq: ["$recurringDetails.frequency", "weekly"] },
                    { $multiply: ["$recurringDetails.amount", 4] },
                    { $multiply: ["$recurringDetails.amount", 30] }, // daily
                  ],
                },
              ],
            },
          },
        },
      },
    ]);

    // Get total subscriptions for retention rate
    const totalSubscriptions = await Order.countDocuments({
      paymentType: "recurring",
    });

    // Get lifetime value calculation
    const lifetimeValue = await Order.aggregate([
      {
        $match: {
          paymentType: "recurring",
        },
      },
      {
        $group: {
          _id: "$user",
          totalValue: { $sum: "$totalAmount" },
        },
      },
      {
        $group: {
          _id: null,
          avgLifetimeValue: { $avg: "$totalValue" },
        },
      },
    ]);

    // Get subscription growth trend
    const currentDate = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(currentDate.getMonth() - 6);

    const monthlyTrend = await Order.aggregate([
      {
        $match: {
          paymentType: "recurring",
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          subscribers: { $sum: 1 },
          amount: { $sum: "$totalAmount" },
        },
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 },
      },
    ]);

   // Format trend data properly including the year
const trendData = monthlyTrend.map((item) => ({
  month: new Date(item._id.year, item._id.month - 1).toLocaleString(
    "default",
    { month: "short" }
  ),
  year: item._id.year, // Make sure to include the year
  amount: item.amount,
  subscribers: item.subscribers,
}));


    const stats = {
      activeSubscriptions: subscriptionStats[0]?.activeSubscriptions || 0,
      monthlyRecurringRevenue:
        subscriptionStats[0]?.monthlyRecurringRevenue || 0,
      retentionRate: subscriptionStats[0]
        ? (subscriptionStats[0].activeSubscriptions / totalSubscriptions) * 100
        : 0,
      avgLifetimeValue: lifetimeValue[0]?.avgLifetimeValue || 0,
      trendData,
    };

    res.json({ status: "Success", data: { stats } });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscription statistics",
      error: error.message,
    });
  }
};

// Get Subscriptions List
exports.getSubscriptions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const frequency = req.query.frequency;
    const status = req.query.status;
    const sortBy = req.query.sortBy || "createdAt";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    const skip = (page - 1) * limit;

    // Build match conditions
    const matchConditions = {
      paymentType: "recurring",
    };

    if (search) {
      matchConditions.$or = [
        { "donorDetails.name": { $regex: search, $options: "i" } },
        { "donorDetails.email": { $regex: search, $options: "i" } },
        { "items.title": { $regex: search, $options: "i" } },
      ];
    }

    if (frequency && frequency !== "All") {
      matchConditions["recurringDetails.frequency"] = frequency.toLowerCase();
    }

    if (status && status !== "All") {
      matchConditions.paymentStatus = status.toLowerCase();
    }

    // Aggregate pipeline
    const subscriptions = await Order.aggregate([
      { $match: matchConditions },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "donor",
        },
      },
      { $unwind: { path: "$donor", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          id: "$_id",
          donationId: 1,
          donorName: "$donorDetails.name",
          donorEmail: "$donorDetails.email",
          cause: { $arrayElemAt: ["$items.title", 0] },
          frequency: "$recurringDetails.frequency",
          amount: "$recurringDetails.amount",
          startDate: "$recurringDetails.startDate",
          status: "$paymentStatus",
          nextBilling: "$recurringDetails.endDate",
          paymentMethod: 1,
          totalAmount: 1,
        },
      },
      { $sort: { [sortBy]: sortOrder } },
      { $skip: skip },
      { $limit: limit },
    ]);

    // Get total count
    const total = await Order.countDocuments(matchConditions);

    res.json({
      status: "Success",
      data: {
        subscriptions,
        pagination: {
          total,
          pages: Math.ceil(total / limit),
          currentPage: page,
          perPage: limit,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscriptions",
      error: error.message,
    });
  }
};

// Get Subscription Details
exports.getSubscriptionDetails = async (req, res) => {
  try {
    const subscription = await Order.findOne({
      _id: req.params.id,
      paymentType: "recurring",
    }).populate("user", "name email phone");

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    res.json({
      status: "Success",
      data: {
        subscription,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch subscription details",
      error: error.message,
    });
  }
};

// Update Subscription Status
exports.updateSubscriptionStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["active", "paused", "cancelled", "failed"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid status value",
      });
    }

    const subscription = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        paymentType: "recurring",
      },
      {
        $set: {
          paymentStatus: status,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        message: "Subscription not found",
      });
    }

    res.json({
      status: "Success",
      data: { subscription },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update subscription status",
      error: error.message,
    });
  }
};