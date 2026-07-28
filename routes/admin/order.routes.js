// routes/admin/order.routes.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const {
  previewPaypalSync,
  commitPaypalSync,
} = require("../../controllers/admin/paypalSyncController");
const {
  getDashboardStats,
  getTopDonors,
  getDonations,
  getDonationsExport,
  getDonationForUser,
  getAllDonations,
  getDonationById, // Added this
  updateDonationStatus, // Added this
} = require("../../controllers/admin/orderController");

router.get("/dashboard/stats", isAdmin, getDashboardStats);
router.get("/dashboard/top-donors", isAdmin, getTopDonors);
router.get("/donations", isAdmin, getDonations);
router.get("/donations/all", isAdmin, getAllDonations);

// Important: Order matters for routes with parameters
// More specific routes should come before general ones to avoid conflicts
router.get("/donations/user/:userId", isAdmin, getDonationForUser); // User-specific route first
router.get("/donations/:id", isAdmin, getDonationById); // Then the general ID route
router.put("/donations/:id/status", isAdmin, updateDonationStatus); // Status update route
router.get("/export", isAdmin, getDonationsExport);

// PayPal donation sync (recover donations lost to failed webhooks).
// Preview accepts an optional PayPal activity export upload in memory —
// it is parsed and discarded, never written to disk/S3.
const paypalExportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [".xlsx", ".xls", ".csv"].includes(
      path.extname(file.originalname || "").toLowerCase()
    );
    cb(ok ? null : new Error("Only .xlsx, .xls or .csv PayPal exports are allowed"), ok);
  },
});
router.post(
  "/paypal-sync/preview",
  isAdmin,
  paypalExportUpload.single("file"),
  previewPaypalSync
);
router.post("/paypal-sync/commit", isAdmin, commitPaypalSync);

module.exports = router;
