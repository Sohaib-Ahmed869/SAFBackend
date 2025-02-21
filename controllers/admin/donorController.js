// routes/admin/donorRoutes.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const Order = require("../../models/order");
const User = require("../../models/user");

// Get Dashboard Stats
router.get("/dashboard/stats", isAdmin, async (req, res) => {
  try {
    // Get total donations and amount
    const totalStats = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$totalAmount" },
          totalDonations: { $sum: 1 },
        },
      },
    ]);

    // Get recurring donors count
    const recurringDonors = await Order.aggregate([
      {
        $match: {
          paymentType: "recurring",
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: "$user",
        },
      },
      {
        $count: "count",
      },
    ]);

    // Calculate success rate
    const allDonations = await Order.countDocuments();
    const successfulDonations = await Order.countDocuments({
      paymentStatus: { $in: ["completed", "active"] },
    });

    const stats = {
      totalAmount: totalStats[0]?.totalAmount || 0,
      averageDonation: totalStats[0]
        ? totalStats[0].totalAmount / totalStats[0].totalDonations
        : 0,
      recurringDonations: recurringDonors[0]?.count || 0,
      successRate: (successfulDonations / allDonations) * 100,
    };

    res.json({ status: "Success", data: { stats } });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch dashboard statistics",
      error: error.message,
    });
  }
});

// Get Donors List
router.get("/", isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const sortBy = req.query.sortBy || "totalDonated";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    const skip = (page - 1) * limit;

    // Build search condition
    const searchCondition = search
      ? {
          $or: [
            { "donor.name": { $regex: search, $options: "i" } },
            { "donor.email": { $regex: search, $options: "i" } },
          ],
        }
      : {};

    // Aggregate pipeline to get donor information
    const aggregatePipeline = [
      // First filter out cancelled orders
      {
        $match: {
          // Only include non-cancelled orders, so remove cancelled orders and failed payments and only include completed and active payments
          status: { $ne: "cancelled" },
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "donor",
        },
      },
      { $unwind: "$donor" },
      {
        $group: {
          _id: "$user",
          name: { $first: "$donor.name" },
          email: { $first: "$donor.email" },
          phone: { $first: "$donor.phone" },
          totalDonated: { $sum: "$totalAmount" },
          donationCount: { $sum: 1 },
          lastDonationDate: { $max: "$createdAt" },
          firstDonationDate: { $min: "$createdAt" },
          donationType: {
            $push: "$paymentType",
          },
        },
      },
      {
        $addFields: {
          id: "$_id",
          donationType: {
            $cond: {
              if: { $in: ["recurring", "$donationType"] },
              then: "recurring",
              else: "one-time",
            },
          },
        },
      },
      { $match: searchCondition },
      { $sort: { [sortBy]: sortOrder } },
      { $skip: skip },
      { $limit: limit },
    ];

    const donors = await Order.aggregate(aggregatePipeline);

    // Get total count for pagination (also filtered by non-cancelled orders)
    const totalCount = await Order.aggregate([
      // Add the same filter here too
      {
        $match: {
          status: { $ne: "cancelled" }, // Only include non-cancelled orders
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "donor",
        },
      },
      { $unwind: "$donor" },
      {
        $group: {
          _id: "$user",
        },
      },
      { $match: searchCondition },
      { $count: "total" },
    ]);

    const total = totalCount[0]?.total || 0;

    res.json({
      status: "Success",
      data: {
        donors,
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
      message: "Failed to fetch donors",
      error: error.message,
    });
  }
});

// Get Donor Details
router.get("/:id", isAdmin, async (req, res) => {
  try {
    const donorId = req.params.id;

    // Get donor basic information
    const donor = await User.findById(donorId);
    if (!donor) {
      return res.status(404).json({
        status: "Error",
        message: "Donor not found",
      });
    }

    // Get donation history
    const donationHistory = await Order.find(
      { user: donorId },
      {
        totalAmount: 1,
        paymentType: 1,
        paymentStatus: 1,
        createdAt: 1,
        items: 1,
      }
    ).sort({ createdAt: -1 });

    // Process donation history
    const processedHistory = donationHistory.map((donation) => ({
      id: donation._id,
      date: donation.createdAt,
      amount: donation.totalAmount,
      status: donation.paymentStatus,
      type: donation.paymentType,
      cause: donation.items[0]?.title || "Multiple Items",
    }));

    res.json({
      status: "Success",
      data: {
        id: donor._id,
        name: donor.name,
        email: donor.email,
        phone: donor.phone,
        donationHistory: processedHistory,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch donor details",
      error: error.message,
    });
  }
});

module.exports = router;
