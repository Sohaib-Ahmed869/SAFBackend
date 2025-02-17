// routes/eventRoutes.js
const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const auth = require("../middleware/auth");

router.post("/", auth, eventController.createEvent);
router.get("/", eventController.getEvents);

module.exports = router;
