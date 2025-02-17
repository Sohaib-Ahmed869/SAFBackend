// controllers/adminController.js
const Order = require("../../models/order");
const User = require("../../models/user");

// Get Dashboard Statistics
exports.getDashboardStats = async (req, res) => {
  try {
    // Get total donations amount
    const totalDonations = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Get recurring donations count
    const recurringDonations = await Order.countDocuments({
      paymentType: { $in: ["recurring", "installments"] },
      paymentStatus: { $in: ["completed", "active"] },
    });

    // Calculate success rate
    const completedDonations = await Order.countDocuments({
      paymentStatus: "completed",
    });
    const totalCount = await Order.countDocuments();
    const successRate = (completedDonations / totalCount) * 100;

    res.json({
      stats: {
        totalAmount: totalDonations[0]?.total || 0,
        averageDonation: totalDonations[0]
          ? totalDonations[0].total / totalDonations[0].count
          : 0,
        recurringDonations,
        successRate,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch dashboard statistics",
      error: error.message,
    });
  }
};

// Get Top Donors
exports.getTopDonors = async (req, res) => {
  try {
    const topDonors = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: "$user",
          totalAmount: { $sum: "$totalAmount" },
          donationCount: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 4 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      { $unwind: "$userInfo" },
      {
        $project: {
          name: "$userInfo.name",
          email: "$userInfo.email",
          total: "$totalAmount",
          donations: "$donationCount",
          image: {
            $ifNull: ["$userInfo.profileImage", "/api/placeholder/50/50"],
          },
        },
      },
    ]);

    res.json({ topDonors });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch top donors",
      error: error.message,
    });
  }
};

// Get Donations List with Filtering and Pagination
exports.getDonations = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      status,
      type,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build filter conditions
    const filter = {};

    if (status && status !== "All") {
      filter.paymentStatus = status;
    }

    if (type && type !== "All") {
      filter.paymentType = type;
    }

    // Search in donor details or donation ID
    if (search) {
      filter.$or = [
        { donationId: { $regex: search, $options: "i" } },
        { "donorDetails.name": { $regex: search, $options: "i" } },
        { "donorDetails.email": { $regex: search, $options: "i" } },
      ];
    }

    // Build sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Execute query with pagination
    const donations = await Order.find(filter)
      .sort(sortConfig)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("user", "name email")
      .lean();

    // Get total count for pagination
    const total = await Order.countDocuments(filter);

    // Format data for response
    const formattedDonations = donations.map((donation) => ({
      id: donation._id,
      donor: donation.donorDetails.name,
      email: donation.donorDetails.email,
      amount: donation.totalAmount,
      cause: donation.items[0]?.title || "Multiple Items",
      date: donation.createdAt,
      status: donation.paymentStatus,
      type: donation.paymentType,
      recurringDetails: donation.recurringDetails,
    }));

    res.json({
      donations: formattedDonations,
      pagination: {
        total,
        pages: Math.ceil(total / limit),
        currentPage: Number(page),
        perPage: Number(limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch donations",
      error: error.message,
    });
  }
};

exports.getDonationsExport = async (req, res) => {
  try {
    // Implementation for exporting donations to CSV
    // Use a library like json2csv
    const donations = await Order.find()
      .populate("user", "name email")
      .sort({ createdAt: -1 });

    // Convert to CSV and send
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=donations.csv");
    // ... implement CSV conversion and sending
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to export donations",
      error: error.message,
    });
  }
};

exports.getDonationForUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const donations = await Order.find({ user: userId }).lean();

    res.json({ donations });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch donations",
      error: error.message,
    });
  }
};
