const express = require('express');
const router = express.Router();
const paypalController = require('../controllers/paypalController');
const optionalAuth = require('../middleware/optionalAuth');

// Create PayPal order
router.post('/create-order', paypalController.createOrder);

// Capture PayPal order
router.post('/capture-order', paypalController.captureOrder);

// Create PayPal subscription
router.post('/create-subscription', paypalController.createSubscription);

// Create dynamic PayPal plan
router.post('/create-dynamic-plan', paypalController.createDynamicPlan);

// Confirm PayPal subscription
router.post('/confirm-subscription', optionalAuth, paypalController.confirmSubscription);

// PayPal webhook endpoint
router.post('/webhook', paypalController.handleWebhook);

module.exports = router; 