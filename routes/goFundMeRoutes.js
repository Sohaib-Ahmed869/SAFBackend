const express = require("express");
const router = express.Router();
const goFundMeController = require("../controllers/goFundMeController");
const auth = require("../middleware/auth");
const adminAuth = require("../middleware/adminAuth");
const { productUpload } = require("../config/s3");

// Public routes
router.get("/public", goFundMeController.getPublicGoFundMes);
router.get("/campaign/:slug", goFundMeController.getGoFundMeBySlug);
router.get("/categories", goFundMeController.getAvailableCategories);

// User routes (protected)
router.post(
  "/",
  auth,
  productUpload.single("image"),
  goFundMeController.createGoFundMe
);
router.get("/my-requests", auth, goFundMeController.getMyGoFundMeRequests);
router.get("/my-donations", auth, goFundMeController.getMyP2PDonations);
router.get("/test-email", auth, goFundMeController.testEmail);

// Payment routes (public)
router.post(
  "/create-payment-intent/:id",
  goFundMeController.createDonationPaymentIntent
);
router.post("/process-donation", goFundMeController.processDonation);
router.post("/paypal-donation/:id", goFundMeController.processPayPalDonation);

// Admin routes (protected)
router.get(
  "/admin/requests",
  auth,
  adminAuth,
  goFundMeController.getAdminGoFundMeRequests
);
router.get(
  "/admin/donors/:id",
  auth,
  adminAuth,
  goFundMeController.getCampaignDonors
);
router.get(
  "/admin/analytics/:id",
  auth,
  adminAuth,
  goFundMeController.getCampaignAnalytics
);
router.put(
  "/admin/review/:id",
  auth,
  adminAuth,
  goFundMeController.reviewGoFundMeRequest
);
router.get(
  "/admin/stats",
  auth,
  adminAuth,
  goFundMeController.getGoFundMeStats
);

module.exports = router;
