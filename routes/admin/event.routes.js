// routes/admin/event.routes.js
const express = require("express");
const router = express.Router();
const eventController = require("../../controllers/admin/eventController");
const isAdmin = require("../../middleware/isAdmin");

// Get event statistics
router.get("/stats", isAdmin, eventController.getEventStats);

// CRUD operations
router.get("/", isAdmin, eventController.getEvents);
router.get("/:id", isAdmin, eventController.getEvent);
router.post("/", isAdmin, eventController.createEvent);
router.put("/:id", isAdmin, eventController.updateEvent);
router.delete("/:id", isAdmin, eventController.deleteEvent);

module.exports = router;
