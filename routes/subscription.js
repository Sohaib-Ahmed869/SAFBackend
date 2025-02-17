// routes/subscription.js
const express = require("express");
const router = express.Router();
const subscriptionController = require("../controllers/subscriptionController");
const auth = require("../middleware/auth");


router.get(
  "/active",
  auth,
  subscriptionController.getActiveSubscriptions
);
router.post(
  "/:subscriptionId/pause",
  auth,
  subscriptionController.pauseSubscription
);
router.post(
  "/:subscriptionId/resume",
  auth,
  subscriptionController.resumeSubscription
);
router.post(
  "/:subscriptionId/cancel",
  auth,
  subscriptionController.cancelSubscription
);
router.put(
  "/:subscriptionId/amount",
  auth,
  subscriptionController.updateSubscriptionAmount
);

module.exports = router;
