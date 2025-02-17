// controllers/orderController.js
const Order = require("../models/order");
const User = require("../models/user");

exports.createOrder = async (req, res) => {
  try {
    const {
      items,
      paymentType,
      adminCostContribution,
      donorDetails,
      paymentMethod,
      totalAmount,
      recurringDetails,
    } = req.body;

    console.log("Received order data:", req.body);

    // Validate required fields
    if (!items || !paymentType || !donorDetails) {
      return res.status(400).json({
        status: "Error",
        message: "Missing required fields",
      });
    }

    // Generate donation ID
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const randomNum = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    const donationId = `D${year}${month}${randomNum}`;

    // Validate recurring payment details
    if (paymentType === "recurring") {
      if (
        !recurringDetails ||
        !recurringDetails.frequency ||
        !recurringDetails.amount
      ) {
        return res.status(400).json({
          status: "Error",
          message: "Recurring payment requires frequency and amount",
        });
      }

      const validFrequencies = ["daily", "weekly", "monthly", "yearly"];
      if (!validFrequencies.includes(recurringDetails.frequency)) {
        return res.status(400).json({
          status: "Error",
          message: "Invalid frequency for recurring payment",
        });
      }
    }

    // Create or update donor information if user exists
    const user = req.user;
    if (donorDetails.rememberDetails && user) {
      await User.findByIdAndUpdate(user._id, {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
        address: {
          street: donorDetails.streetAddress,
          city: donorDetails.townCity,
          state: donorDetails.state,
          postcode: donorDetails.postcode,
        },
      });
    }

    // Process items array
    const processedItems = items.map((item) => ({
      title: item.title,
      price: item.price,
      quantity: item.quantity || 1,
      onBehalfOf: item.onBehalfOf || null,
    }));

    // Prepare recurring details if applicable
    let orderRecurringDetails = null;
    if (paymentType === "recurring") {
      orderRecurringDetails = {
        frequency: recurringDetails.frequency,
        amount: recurringDetails.amount,
        startDate: new Date(),
        status: "active",
        nextPaymentDate: calculateNextPaymentDate(
          new Date(),
          recurringDetails.frequency
        ),
        totalPayments: 0,
        paymentHistory: [],
      };
    }

    // Create order with donationId
    const order = new Order({
      user: user ? user._id : null,
      donationId, // Add donationId here
      items: processedItems,
      paymentType,
      adminCostContribution: {
        included: !!adminCostContribution,
        amount: adminCostContribution || 0,
      },
      donorDetails: {
        name: donorDetails.name,
        phone: donorDetails.phone,
        email: donorDetails.email,
        address: {
          street: donorDetails.streetAddress,
          city: donorDetails.townCity,
          state: donorDetails.state,
          postcode: donorDetails.postcode,
        },
        agreeToMessages: donorDetails.agreeToMessages,
      },
      paymentMethod,
      paymentStatus: paymentMethod === "bank" ? "pending" : "processing",
      totalAmount,
      recurringDetails: orderRecurringDetails,
    });

    // Attempt to save with retries in case of donationId collision
    let savedOrder = null;
    let retries = 3;

    while (retries > 0) {
      try {
        savedOrder = await order.save();
        break;
      } catch (error) {
        if (error.code === 11000 && error.keyPattern.donationId) {
          // Duplicate donationId, generate a new one and retry
          order.donationId = `D${year}${month}${Math.floor(
            Math.random() * 10000
          )
            .toString()
            .padStart(4, "0")}`;
          retries--;
        } else {
          throw error;
        }
      }
    }

    if (!savedOrder) {
      throw new Error(
        "Failed to generate unique donation ID after multiple attempts"
      );
    }

    console.log("Order saved:", savedOrder);

    // Send response
    res.status(201).json({
      status: "Success",
      message: "Order created successfully",
      order: {
        _id: savedOrder._id,
        donationId: savedOrder.donationId,
        totalAmount: savedOrder.totalAmount,
        paymentStatus: savedOrder.paymentStatus,
        recurringDetails: orderRecurringDetails,
        paymentInstructions:
          paymentMethod === "bank"
            ? {
                bankName: "Westpac",
                bsb: "032075",
                accountNumber: "841783",
                reference: savedOrder.donationId,
              }
            : null,
      },
    });
  } catch (error) {
    console.error("Order creation error:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to create order",
      error: error.message,
    });
  }
};
exports.getOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select("-__v");

    res.json({
      status: "Success",
      orders,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).select("-__v");

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    // Check if user has access to this order
    if (order.user && order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: "Error",
        message: "Not authorized to view this order",
      });
    }

    res.json({
      status: "Success",
      order,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch order",
      error: error.message,
    });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { paymentStatus, transactionDetails } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        status: "Error",
        message: "Order not found",
      });
    }

    order.paymentStatus = paymentStatus;
    if (transactionDetails) {
      order.transactionDetails = transactionDetails;
    }

    await order.save();

    // Create log entry
    await createLog("UPDATE", "ORDER", order._id, req.user, req, {
      paymentStatus,
    });

    res.json({
      status: "Success",
      message: "Order status updated",
      order,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

exports.getOrderStats = async (req, res) => {
  try {
    const userId = req.user._id;

    console.log("Getting order stats for user:", req.user);

    // Get all orders for the user
    const orders = await Order.find({ user: userId });

    // Calculate total donated amount
    const totalDonated = orders.reduce(
      (sum, order) => sum + order.totalAmount,
      0
    );

    // Calculate recurring donations
    const recurringOrders = orders.filter(
      (order) =>
        order.paymentType === "recurring" ||
        order.paymentType === "installments"
    );

    // Calculate active recurring (not failed or completed)
    const activeRecurring = recurringOrders.filter(
      (order) =>
        order.paymentStatus !== "failed" && order.paymentStatus !== "completed"
    ).length;

    // Count one-time donations
    const oneTimeOrders = orders.filter(
      (order) => order.paymentType === "single"
    );

    const stats = {
      totalDonated,
      activeRecurring,
      recurringCount: recurringOrders.length,
      oneTimeCount: oneTimeOrders.length,
      totalOrders: orders.length,
      // Additional stats
      completedOrders: orders.filter(
        (order) => order.paymentStatus === "completed"
      ).length,
      pendingOrders: orders.filter((order) => order.paymentStatus === "pending")
        .length,
      failedOrders: orders.filter((order) => order.paymentStatus === "failed")
        .length,
      // Monthly stats
      monthlyStats: getMonthlyStats(orders),
    };

    res.json({
      status: "Success",
      stats,
    });
  } catch (error) {
    console.error("Error getting order stats:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to get order statistics",
      error: error.message,
    });
  }
};

// Helper function to calculate monthly stats
const getMonthlyStats = (orders) => {
  const monthlyData = {};

  orders.forEach((order) => {
    const date = new Date(order.createdAt);
    const monthYear = `${date.getFullYear()}-${String(
      date.getMonth() + 1
    ).padStart(2, "0")}`;

    if (!monthlyData[monthYear]) {
      monthlyData[monthYear] = {
        total: 0,
        count: 0,
        recurring: 0,
        oneTime: 0,
      };
    }

    monthlyData[monthYear].total += order.totalAmount;
    monthlyData[monthYear].count += 1;

    if (order.paymentType === "single") {
      monthlyData[monthYear].oneTime += 1;
    } else {
      monthlyData[monthYear].recurring += 1;
    }
  });

  // Convert to array and sort by date
  return Object.entries(monthlyData)
    .map(([month, data]) => ({
      month,
      ...data,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
};

// Helper function to calculate next payment date
const calculateNextPaymentDate = (startDate, frequency) => {
  const nextDate = new Date(startDate);

  switch (frequency) {
    case "daily":
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case "weekly":
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case "monthly":
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case "yearly":
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      break;
  }

  return nextDate;
};
