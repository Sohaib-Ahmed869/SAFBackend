const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const {
  getDashboardStats,
  getTopDonors,
  getDonations,
  getDonationsExport,
  getDonationForUser,
} = require("../../controllers/admin/orderController");

router.get("/dashboard/stats", isAdmin, getDashboardStats);
router.get("/dashboard/top-donors", isAdmin, getTopDonors);
router.get("/donations", isAdmin, getDonations);
router.get("/donations/:userId", isAdmin, getDonationForUser);
router.get("/export", isAdmin, getDonationsExport);

module.exports = router;
