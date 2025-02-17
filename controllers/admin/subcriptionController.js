// controllers/admin/subscriptionController.js
const Order = require("../../models/order");

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

    // Format trend data
    const trendData = monthlyTrend.map((item) => ({
      month: new Date(item._id.year, item._id.month - 1).toLocaleString(
        "default",
        { month: "short" }
      ),
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
