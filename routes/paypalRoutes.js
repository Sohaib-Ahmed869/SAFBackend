const express = require('express');
const router = express.Router();
const paypalController = require('../controllers/paypalController');

// Create PayPal order
router.post('/create-order', paypalController.createOrder);

// Capture PayPal order
router.post('/capture-order', paypalController.captureOrder);

module.exports = router; 