// routes/admin/order.routes.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const {
  previewPaypalSync,
  commitPaypalSync,
  downloadSyncTemplate,
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

// Donation sync (recover PayPal/bank donations missing from the DB).
// Preview accepts an optional spreadsheet upload in memory — a PayPal activity
// export or a filled-out SAF template. It is parsed and discarded, never
// written to disk/S3.
const syncFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [".xlsx", ".xls", ".csv"].includes(
      path.extname(file.originalname || "").toLowerCase()
    );
    cb(ok ? null : new Error("Only .xlsx, .xls or .csv files are allowed"), ok);
  },
});
router.get("/donation-sync/template", isAdmin, downloadSyncTemplate);
router.post(
  "/donation-sync/preview",
  isAdmin,
  syncFileUpload.single("file"),
  previewPaypalSync
);
router.post("/donation-sync/commit", isAdmin, commitPaypalSync);
// Aliases from when the feature was PayPal-only — keep old clients working.
router.post(
  "/paypal-sync/preview",
  isAdmin,
  syncFileUpload.single("file"),
  previewPaypalSync
);
router.post("/paypal-sync/commit", isAdmin, commitPaypalSync);

module.exports = router;
