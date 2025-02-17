// routes/admin/subscriptionRoutes.js
const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const {
  getDashboardStats,
  getSubscriptions,
  getSubscriptionDetails,
  updateSubscriptionStatus,
} = require("../../controllers/admin/subcriptionController");

// Dashboard Statistics
router.get("/dashboard/subscription-stats", isAdmin, getDashboardStats);

// Get Subscriptions List
router.get("/", isAdmin, getSubscriptions);

// Get Subscription Details
router.get("/:id", isAdmin, getSubscriptionDetails);

// Update Subscription Status
router.patch("/:id/status", isAdmin, updateSubscriptionStatus);

module.exports = router;
