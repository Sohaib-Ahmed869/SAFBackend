// controllers/admin/eventController.js
const Event = require("../../models/event");

// Get all events with filtering and pagination
exports.getEvents = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      status,
      sortBy = "date",
      sortOrder = "desc",
      startDate,
      endDate,
    } = req.query;

    // Build filter conditions
    const filter = {};

    if (status && status !== "all") {
      filter.status = status;
    }

    // Date range filter
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    // Search in title, description, or location
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { "location.city": { $regex: search, $options: "i" } },
        { "location.venue": { $regex: search, $options: "i" } },
      ];
    }

    // Build sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Execute query with pagination
    const events = await Event.find(filter)
      .sort(sortConfig)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Get total count for pagination
    const total = await Event.countDocuments(filter);

    res.json({
      events,
      pagination: {
        total,
        pages: Math.ceil(total / limit),
        currentPage: Number(page),
        perPage: Number(limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch events",
      error: error.message,
    });
  }
};

// Get single event
exports.getEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({
        status: "Error",
        message: "Event not found",
      });
    }
    res.json(event);
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch event",
      error: error.message,
    });
  }
};

// Create new event
exports.createEvent = async (req, res) => {
  try {
    const {
      title,
      date,
      startTime,
      endTime,
      timezone,
      location,
      description,
      imageUrl,
      registrationLink,
      status,
    } = req.body;

    console.log(req.body);

    const event = new Event({
      title,
      date,
      startTime,
      endTime,
      timezone,
      location,
      description,
      imageUrl,
      registrationLink,
      status: status || "upcoming",
    });

    await event.save();

    res.status(201).json({
      status: "Success",
      message: "Event created successfully",
      event,
    });
  } catch (error) {
    console.error("Event creation error:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to create event",
      error: error.message,
    });
  }
};

// Update event
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!event) {
      return res.status(404).json({
        status: "Error",
        message: "Event not found",
      });
    }

    res.json({
      status: "Success",
      message: "Event updated successfully",
      event,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update event",
      error: error.message,
    });
  }
};

// Delete event
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);

    if (!event) {
      return res.status(404).json({
        status: "Error",
        message: "Event not found",
      });
    }

    res.json({
      status: "Success",
      message: "Event deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to delete event",
      error: error.message,
    });
  }
};

// Get event statistics
exports.getEventStats = async (req, res) => {
  try {
    const stats = await Event.aggregate([
      {
        $facet: {
          totalEvents: [{ $count: "count" }],
          byStatus: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
          byCity: [
            {
              $group: {
                _id: "$location.city",
                count: { $sum: 1 },
              },
            },
          ],
          upcomingEvents: [
            {
              $match: {
                date: { $gte: new Date() },
                status: "upcoming",
              },
            },
            { $count: "count" },
          ],
        },
      },
    ]);

    const formattedStats = {
      totalEvents: stats[0].totalEvents[0]?.count || 0,
      upcomingEvents: stats[0].upcomingEvents[0]?.count || 0,
      statusDistribution: stats[0].byStatus,
      cityDistribution: stats[0].byCity.filter((city) => city._id != null),
    };

    res.json({
      status: "Success",
      stats: formattedStats,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch event statistics",
      error: error.message,
    });
  }
};
