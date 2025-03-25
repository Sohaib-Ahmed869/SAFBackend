// routes/admin/donorRoutes.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const Order = require("../../models/order");
const User = require("../../models/user");

// Get Dashboard Stats
// router.get("/dashboard/stats", isAdmin, async (req, res) => {
//   try {
//     // First, group orders by donor (user) for orders with completed/active paymentStatus
//     const donorsAggregation = await Order.aggregate([
//       {
//         $match: {
//           paymentStatus: { $in: ["completed", "active"] },
//         },
//       },
//       {
//         $group: {
//           _id: "$user",
//           donorTotal: { $sum: "$totalAmount" },
//           orderCount: { $sum: 1 },
//         },
//       },
//     ]);
    
//     // Compute overall totals based on distinct donors
//     const totalDonors = donorsAggregation.length;
//     const totalAmount = donorsAggregation.reduce(
//       (sum, doc) => sum + doc.donorTotal,
//       0
//     );
//     const averageDonation = totalDonors > 0 ? totalAmount / totalDonors : 0;
    
//     // Get recurring donors count (distinct donors with recurring orders)
//     const recurringDonorsAgg = await Order.aggregate([
//       {
//         $match: {
//           paymentType: "recurring",
//           paymentStatus: { $in: ["completed", "active"] },
//         },
//       },
//       {
//         $group: {
//           _id: "$user",
//         },
//       },
//       { $count: "count" },
//     ]);
//     const recurringCount = recurringDonorsAgg[0]?.count || 0;
    
//     // Calculate success rate based on all orders (if needed)
//     const allDonations = await Order.countDocuments();
//     const successfulDonations = await Order.countDocuments({
//       paymentStatus: { $in: ["completed", "active"] },
//     });
//     const successRate = allDonations ? (successfulDonations / allDonations) * 100 : 0;
    
//     const stats = {
//       totalAmount,
//       totalDonors,
//       averageDonation,
//       recurringDonations: recurringCount,
//       successRate,
//     };
    
//     console.log("Aggregated donors:", donorsAggregation);
//     console.log("Computed stats:", stats);
    
//     res.json({ status: "Success", data: { stats, donorsAggregation } });
//   } catch (error) {
//     res.status(500).json({
//       status: "Error",
//       message: "Failed to fetch dashboard statistics",
//       error: error.message,
//     });
//   }
// });


router.get("/dashboard/stats", isAdmin, async (req, res) => {
  try {
    // Group orders by donor for orders with completed/active paymentStatus
    const donorsAggregation = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: "$user",
          donorTotal: { $sum: "$totalAmount" },
          orderCount: { $sum: 1 },
        },
      },
    ]);

    // Compute overall totals based on distinct donors
    const totalDonors = donorsAggregation.length; // number of unique donors
    const totalAmount = donorsAggregation.reduce(
      (sum, doc) => sum + doc.donorTotal,
      0
    );
    const averageDonation = totalDonors > 0 ? totalAmount / totalDonors : 0;

    // Get recurring donors count (distinct donors with recurring orders)
    const recurringDonorsAgg = await Order.aggregate([
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
      { $count: "count" },
    ]);
    const recurringCount = recurringDonorsAgg[0]?.count || 0;

    // Calculate success rate
    const allDonations = await Order.countDocuments();
    const successfulDonations = await Order.countDocuments({
      paymentStatus: { $in: ["completed", "active"] },
    });
    const successRate = allDonations ? (successfulDonations / allDonations) * 100 : 0;

    const stats = {
      totalAmount,
      totalDonors,
      averageDonation, // computed as totalAmount / totalDonors
      recurringDonations: recurringCount,
      successRate,
    };

    console.log("Aggregated donors:", donorsAggregation);
    console.log("Computed stats:", stats);

    res.json({ status: "Success", data: { stats, donorsAggregation } });
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
    const type = req.query.type || "All"; // "All", "single", "recurring", or "installments"

    const skip = (page - 1) * limit;

    // Build search condition on grouped fields (name and email)
    const searchCondition = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    // Prepare donation type filter (convert "single" to "one-time")
    let typeFilter;
    if (type && type !== "All") {
      typeFilter = type === "single" ? "one-time" : type;
    }

    // Aggregation pipeline to get donor info
    const aggregatePipeline = [
      {
        $match: {
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
          donationTypes: { $push: "$paymentType" },
        },
      },
      {
        $addFields: {
          id: "$_id",
          donationType: {
            $cond: {
              if: { $in: ["recurring", "$donationTypes"] },
              then: "recurring",
              else: "one-time",
            },
          },
        },
      },
    ];

    // If a donation type filter exists, add it
    if (typeFilter) {
      aggregatePipeline.push({ $match: { donationType: typeFilter } });
    }

    // Add the search condition if provided
    if (Object.keys(searchCondition).length > 0) {
      aggregatePipeline.push({ $match: searchCondition });
    }

    // Finally add sorting, pagination
    aggregatePipeline.push(
      { $sort: { [sortBy]: sortOrder } },
      { $skip: skip },
      { $limit: limit }
    );

    const donors = await Order.aggregate(aggregatePipeline);

    // Build a similar pipeline for total count (exclude pagination stages)
    const countPipeline = [
      {
        $match: {
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
          donationTypes: { $push: "$paymentType" },
        },
      },
      {
        $addFields: {
          donationType: {
            $cond: {
              if: { $in: ["recurring", "$donationTypes"] },
              then: "recurring",
              else: "one-time",
            },
          },
        },
      },
    ];

    if (typeFilter) {
      countPipeline.push({ $match: { donationType: typeFilter } });
    }

    if (Object.keys(searchCondition).length > 0) {
      countPipeline.push({ $match: searchCondition });
    }

    countPipeline.push({ $count: "total" });
    const totalCountResult = await Order.aggregate(countPipeline);
    const total = totalCountResult[0]?.total || 0;

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
    const donor = await User.findById(donorId);
    if (!donor) {
      return res.status(404).json({
        status: "Error",
        message: "Donor not found",
      });
    }

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
