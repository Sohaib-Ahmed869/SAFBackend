// routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderContrller");
const auth = require("../middleware/auth");

// Public routes (no authentication required)
router.post("/create",auth, orderController.createOrder); // Allow anonymous donations

// Protected routes (authentication required)
router.get("/my-orders", auth, orderController.getOrders);
router.get("/stats", auth, orderController.getOrderStats);
router.get("/:id", auth, orderController.getOrderById);
router.patch("/:id/status", auth, orderController.updateOrderStatus);

module.exports = router;
