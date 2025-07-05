const GoFundMe = require("../models/goFundMe");
const GoFundMeDonation = require("../models/goFundMeDonations");
const User = require("../models/user");
const mongoose = require("mongoose");
const { deleteS3Object } = require("../config/s3");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// @desc    Create a new GoFundMe request
// @route   POST /api/gofundme
// @access  Private
exports.createGoFundMe = async (req, res) => {
  try {
    const {
      title,
      description,
      personalStory,
      financialSituation,
      reasonForFunding,
      targetAmount,
      category,
      urgencyLevel,
    } = req.body;

    // Validate required fields
    if (
      !title ||
      !description ||
      !personalStory ||
      !financialSituation ||
      !reasonForFunding ||
      !targetAmount ||
      !category
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required fields",
      });
    }

    // Check if user already has a pending or approved GoFundMe
    const existingGoFundMe = await GoFundMe.findOne({
      userId: req.user.id,
      status: { $in: ["pending", "approved"] },
    });

    if (existingGoFundMe) {
      return res.status(400).json({
        success: false,
        message:
          "You already have an active GoFundMe request. Please wait for approval or completion.",
      });
    }

    // Check if image was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Image is required for GoFundMe request",
      });
    }

    // Create new GoFundMe request
    const goFundMe = new GoFundMe({
      userId: req.user.id,
      title,
      description,
      personalStory,
      financialSituation,
      reasonForFunding,
      targetAmount: Number.parseFloat(targetAmount),
      category,
      urgencyLevel: urgencyLevel || "medium",
      image: req.file.location,
      imagePath: req.file.key,
    });

    const savedGoFundMe = await goFundMe.save();
    await savedGoFundMe.populate("userId", "name email");

    res.status(201).json({
      success: true,
      message:
        "GoFundMe request submitted successfully. It will be reviewed by our admin team.",
      goFundMe: savedGoFundMe,
    });
  } catch (error) {
    console.error("Error creating GoFundMe:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get user's GoFundMe requests
// @route   GET /api/gofundme/my-requests
// @access  Private
exports.getMyGoFundMeRequests = async (req, res) => {
  try {
    const goFundMes = await GoFundMe.find({ userId: req.user.id })
      .populate("userId", "name email")
      .populate("approvedBy", "name")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      goFundMes,
    });
  } catch (error) {
    console.error("Error fetching user GoFundMe requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get all approved GoFundMe campaigns (public)
// @route   GET /api/gofundme/public
// @access  Public
exports.getPublicGoFundMes = async (req, res) => {
  try {
    const {
      category,
      urgency,
      sort = "recent",
      page = 1,
      limit = 12,
    } = req.query;

    const query = {
      status: "approved",
      isActive: true,
    };

    // Add filters
    if (category && category !== "all") {
      query.category = category;
    }

    if (urgency && urgency !== "all") {
      query.urgencyLevel = urgency;
    }

    // Sort options
    let sortOption = {};
    switch (sort) {
      case "recent":
        sortOption = { approvedAt: -1 };
        break;
      case "urgent":
        sortOption = { urgencyLevel: -1, approvedAt: -1 };
        break;
      case "amount":
        sortOption = { targetAmount: -1 };
        break;
      case "progress":
        sortOption = { currentAmount: -1 };
        break;
      default:
        sortOption = { approvedAt: -1 };
    }

    const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit);

    const goFundMes = await GoFundMe.find(query)
      .populate("userId", "name")
      .sort(sortOption)
      .skip(skip)
      .limit(Number.parseInt(limit));

    const total = await GoFundMe.countDocuments(query);

    res.json({
      success: true,
      goFundMes,
      pagination: {
        current: Number.parseInt(page),
        pages: Math.ceil(total / Number.parseInt(limit)),
        total,
      },
    });
  } catch (error) {
    console.error("Error fetching public GoFundMe campaigns:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get single GoFundMe by slug
// @route   GET /api/gofundme/campaign/:slug
// @access  Public
exports.getGoFundMeBySlug = async (req, res) => {
  try {
    const goFundMe = await GoFundMe.findOne({
      slug: req.params.slug,
      status: "approved",
      isActive: true,
    }).populate("userId", "name");

    if (!goFundMe) {
      return res.status(404).json({
        success: false,
        message: "GoFundMe campaign not found",
      });
    }

    // Get recent donations (non-anonymous)
    const recentDonations = await GoFundMeDonation.find({
      goFundMeId: goFundMe._id,
      paymentStatus: "completed",
      isAnonymous: false,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("donorName amount message createdAt");

    res.json({
      success: true,
      goFundMe,
      recentDonations,
    });
  } catch (error) {
    console.error("Error fetching GoFundMe campaign:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Create payment intent for GoFundMe donation
// @route   POST /api/gofundme/create-payment-intent/:id
// @access  Public
exports.createDonationPaymentIntent = async (req, res) => {
  try {
    const { amount, donorName, donorEmail, message, isAnonymous } = req.body;
    const goFundMeId = req.params.id;

    // Validate input
    if (!amount || !donorName || !donorEmail) {
      return res.status(400).json({
        success: false,
        message: "Amount, donor name, and email are required",
      });
    }

    // Find GoFundMe campaign
    const goFundMe = await GoFundMe.findById(goFundMeId).populate(
      "userId",
      "name"
    );
    if (!goFundMe || goFundMe.status !== "approved" || !goFundMe.isActive) {
      return res.status(404).json({
        success: false,
        message: "GoFundMe campaign not found or not active",
      });
    }

    // Check if campaign is already completed
    if (goFundMe.currentAmount >= goFundMe.targetAmount) {
      return res.status(400).json({
        success: false,
        message: "This campaign has already reached its target",
      });
    }

    const donationAmount = Number.parseFloat(amount);
    if (donationAmount < 1) {
      return res.status(400).json({
        success: false,
        message: "Minimum donation amount is $1",
      });
    }

    const stripeAmount = Math.round(donationAmount * 100); // Convert to cents

    // Calculate fees (Stripe fee: 2.9% + 30¢)
    const stripeFee = Math.round(stripeAmount * 0.029 + 30);
    const netAmount = donationAmount - stripeFee / 100;

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: stripeAmount,
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        goFundMeId: goFundMeId,
        donorName,
        donorEmail,
        message: message || "",
        isAnonymous: isAnonymous || "false",
        netAmount: netAmount.toString(),
        paymentType: "gofundme_donation",
      },
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Process donation after successful payment
// @route   POST /api/gofundme/process-donation
// @access  Public
exports.processDonation = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: "Payment intent ID is required",
      });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        success: false,
        message: "Payment not completed",
      });
    }

    const {
      goFundMeId,
      donorName,
      donorEmail,
      message,
      isAnonymous,
      netAmount,
    } = paymentIntent.metadata;

    // Check if donation already exists
    const existingDonation = await GoFundMeDonation.findOne({
      stripePaymentIntentId: paymentIntentId,
    });

    if (existingDonation) {
      return res.json({
        success: true,
        message: "Donation already processed",
        donation: existingDonation,
        alreadyProcessed: true,
      });
    }

    // Create donation record
    const donation = new GoFundMeDonation({
      goFundMeId,
      donorName,
      donorEmail,
      amount: paymentIntent.amount / 100,
      message,
      isAnonymous: isAnonymous === "true",
      stripePaymentIntentId: paymentIntentId,
      paymentStatus: "completed",
      transactionFee: paymentIntent.amount / 100 - Number.parseFloat(netAmount),
      netAmount: Number.parseFloat(netAmount),
      paymentMethod: "stripe",
    });

    await donation.save();

    // Update GoFundMe campaign
    const goFundMe = await GoFundMe.findById(goFundMeId);
    goFundMe.currentAmount += Number.parseFloat(netAmount);
    goFundMe.donationCount += 1;

    // Check if target reached
    if (goFundMe.currentAmount >= goFundMe.targetAmount) {
      goFundMe.status = "completed";
      goFundMe.completedAt = new Date();
      goFundMe.isActive = false;
    }

    await goFundMe.save();

    res.json({
      success: true,
      message: "Donation completed successfully",
      donation,
      campaign: {
        title: goFundMe.title,
        slug: goFundMe.slug,
        currentAmount: goFundMe.currentAmount,
        targetAmount: goFundMe.targetAmount,
        donationCount: goFundMe.donationCount,
        isCompleted: goFundMe.status === "completed",
      },
    });
  } catch (error) {
    console.error("Error processing donation:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Process PayPal donation for GoFundMe
// @route   POST /api/gofundme/paypal-donation/:id
// @access  Public
exports.processPayPalDonation = async (req, res) => {
  try {
    const {
      amount,
      donorName,
      donorEmail,
      message,
      isAnonymous,
      paypalOrderId,
    } = req.body;
    const goFundMeId = req.params.id;

    // Validate input
    if (!amount || !donorName || !donorEmail || !paypalOrderId) {
      return res.status(400).json({
        success: false,
        message: "All fields including PayPal order ID are required",
      });
    }

    // Find GoFundMe campaign
    const goFundMe = await GoFundMe.findById(goFundMeId);
    if (!goFundMe || goFundMe.status !== "approved" || !goFundMe.isActive) {
      return res.status(404).json({
        success: false,
        message: "GoFundMe campaign not found or not active",
      });
    }

    const donationAmount = Number.parseFloat(amount);

    // Calculate fees (PayPal fee: 2.9% + 30¢)
    const paypalFee = Math.round((donationAmount * 0.029 + 0.3) * 100) / 100;
    const netAmount = donationAmount - paypalFee;

    // Create donation record
    const donation = new GoFundMeDonation({
      goFundMeId,
      donorName,
      donorEmail,
      amount: donationAmount,
      message,
      isAnonymous: isAnonymous || false,
      stripePaymentIntentId: paypalOrderId, // Using this field for PayPal order ID
      paymentStatus: "completed",
      transactionFee: paypalFee,
      netAmount: netAmount,
      paymentMethod: "paypal",
    });

    await donation.save();

    // Update GoFundMe campaign
    goFundMe.currentAmount += netAmount;
    goFundMe.donationCount += 1;

    // Check if target reached
    if (goFundMe.currentAmount >= goFundMe.targetAmount) {
      goFundMe.status = "completed";
      goFundMe.completedAt = new Date();
      goFundMe.isActive = false;
    }

    await goFundMe.save();

    res.json({
      success: true,
      message: "PayPal donation completed successfully",
      donation,
      campaign: {
        title: goFundMe.title,
        slug: goFundMe.slug,
        currentAmount: goFundMe.currentAmount,
        targetAmount: goFundMe.targetAmount,
        donationCount: goFundMe.donationCount,
        isCompleted: goFundMe.status === "completed",
      },
    });
  } catch (error) {
    console.error("Error processing PayPal donation:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// ADMIN ROUTES

// @desc    Get all GoFundMe requests for admin
// @route   GET /api/gofundme/admin/requests
// @access  Private/Admin
exports.getAdminGoFundMeRequests = async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 10, search = "" } = req.query;

    const query = {};
    if (status !== "all") {
      query.status = status;
    }

    // Add search functionality
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit);

    const goFundMes = await GoFundMe.find(query)
      .populate("userId", "name email")
      .populate("approvedBy", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit));

    const total = await GoFundMe.countDocuments(query);

    res.json({
      success: true,
      goFundMes,
      pagination: {
        current: Number.parseInt(page),
        pages: Math.ceil(total / Number.parseInt(limit)),
        total,
      },
    });
  } catch (error) {
    console.error("Error fetching admin GoFundMe requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get donors for a specific campaign
// @route   GET /api/gofundme/admin/donors/:id
// @access  Private/Admin
exports.getCampaignDonors = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const campaignId = req.params.id;

    const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit);

    const donations = await GoFundMeDonation.find({
      goFundMeId: campaignId,
      paymentStatus: "completed",
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .select(
        "donorName donorEmail amount message isAnonymous paymentMethod createdAt transactionFee netAmount"
      );

    const total = await GoFundMeDonation.countDocuments({
      goFundMeId: campaignId,
      paymentStatus: "completed",
    });

    // Get campaign details
    const campaign = await GoFundMe.findById(campaignId).select("title");

    res.json({
      success: true,
      donors: donations,
      campaign,
      pagination: {
        current: Number.parseInt(page),
        pages: Math.ceil(total / Number.parseInt(limit)),
        total,
      },
    });
  } catch (error) {
    console.error("Error fetching campaign donors:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get analytics for a specific campaign
// @route   GET /api/gofundme/admin/analytics/:id
// @access  Private/Admin
exports.getCampaignAnalytics = async (req, res) => {
  try {
    const campaignId = req.params.id;

    // Get campaign details
    const campaign = await GoFundMe.findById(campaignId)
      .populate("userId", "name email")
      .select(
        "title targetAmount currentAmount donationCount status createdAt approvedAt completedAt"
      );

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found",
      });
    }

    // Get donation analytics
    const donationStats = await GoFundMeDonation.aggregate([
      {
        $match: {
          goFundMeId: new mongoose.Types.ObjectId(campaignId),
          paymentStatus: "completed",
        },
      },
      {
        $group: {
          _id: null,
          totalDonations: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          totalNetAmount: { $sum: "$netAmount" },
          totalFees: { $sum: "$transactionFee" },
          averageDonation: { $avg: "$amount" },
          maxDonation: { $max: "$amount" },
          minDonation: { $min: "$amount" },
        },
      },
    ]);

    // Get donations by payment method
    const paymentMethodStats = await GoFundMeDonation.aggregate([
      {
        $match: {
          goFundMeId: new mongoose.Types.ObjectId(campaignId),
          paymentStatus: "completed",
        },
      },
      {
        $group: {
          _id: "$paymentMethod",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
    ]);

    // Get donations over time (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const donationsOverTime = await GoFundMeDonation.aggregate([
      {
        $match: {
          goFundMeId: new mongoose.Types.ObjectId(campaignId),
          paymentStatus: "completed",
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    // Get anonymous vs non-anonymous donations
    const anonymityStats = await GoFundMeDonation.aggregate([
      {
        $match: {
          goFundMeId: new mongoose.Types.ObjectId(campaignId),
          paymentStatus: "completed",
        },
      },
      {
        $group: {
          _id: "$isAnonymous",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
    ]);

    res.json({
      success: true,
      campaign,
      analytics: {
        overview: donationStats[0] || {
          totalDonations: 0,
          totalAmount: 0,
          totalNetAmount: 0,
          totalFees: 0,
          averageDonation: 0,
          maxDonation: 0,
          minDonation: 0,
        },
        paymentMethods: paymentMethodStats,
        donationsOverTime,
        anonymityStats,
        progressPercentage:
          campaign.targetAmount > 0
            ? (campaign.currentAmount / campaign.targetAmount) * 100
            : 0,
      },
    });
  } catch (error) {
    console.error("Error fetching campaign analytics:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Approve/Reject GoFundMe request
// @route   PUT /api/gofundme/admin/review/:id
// @access  Private/Admin
exports.reviewGoFundMeRequest = async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const goFundMeId = req.params.id;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Must be approved or rejected",
      });
    }

    const goFundMe = await GoFundMe.findById(goFundMeId);
    if (!goFundMe) {
      return res.status(404).json({
        success: false,
        message: "GoFundMe request not found",
      });
    }

    if (goFundMe.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "This request has already been reviewed",
      });
    }

    goFundMe.status = status;
    goFundMe.adminNotes = adminNotes;
    goFundMe.approvedBy = req.user.id;
    goFundMe.approvedAt = new Date();

    await goFundMe.save();
    await goFundMe.populate("userId", "name email");

    res.json({
      success: true,
      message: `GoFundMe request ${status} successfully`,
      goFundMe,
    });
  } catch (error) {
    console.error("Error reviewing GoFundMe request:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// @desc    Get GoFundMe statistics
// @route   GET /api/gofundme/admin/stats
// @access  Private/Admin
exports.getGoFundMeStats = async (req, res) => {
  try {
    const totalRequests = await GoFundMe.countDocuments();
    const pendingRequests = await GoFundMe.countDocuments({
      status: "pending",
    });
    const approvedCampaigns = await GoFundMe.countDocuments({
      status: "approved",
    });
    const completedCampaigns = await GoFundMe.countDocuments({
      status: "completed",
    });

    const totalDonations = await GoFundMeDonation.countDocuments({
      paymentStatus: "completed",
    });
    const totalAmountRaised = await GoFundMeDonation.aggregate([
      { $match: { paymentStatus: "completed" } },
      { $group: { _id: null, total: { $sum: "$netAmount" } } },
    ]);

    res.json({
      success: true,
      stats: {
        totalRequests,
        pendingRequests,
        approvedCampaigns,
        completedCampaigns,
        totalDonations,
        totalAmountRaised: totalAmountRaised[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching GoFundMe stats:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};
