// controllers/adminController.js
const Order = require("../../models/order");
const User = require("../../models/user");
const { sendEmail } = require("../../services/emailUtil");

exports.getDashboardStats = async (req, res) => {
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // Get total donations amount - KEEP ORIGINAL QUERY STRUCTURE
    const totalDonations = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Get recurring donations count - KEEP ORIGINAL QUERY
    const recurringDonations = await Order.countDocuments({
      paymentType: { $in: ["recurring", "installments"] },
      paymentStatus: { $in: ["completed", "active"] },
    });

    // KEEP ORIGINAL SUCCESS RATE CALCULATION but fix any division by zero issues
    const completedDonations = await Order.countDocuments({
      paymentStatus: "completed",
    });
    const totalCount = await Order.countDocuments();
    const successRate =
      totalCount > 0 ? (completedDonations / totalCount) * 100 : 0;

    // Process actual payments behind the scenes to get real totals
    let actualTotalAmount = 0;

    // Get all completed/active orders
    const allOrders = await Order.find({
      paymentStatus: { $in: ["completed", "active"] },
    }).lean();

    // Calculate actual payments
    await Promise.all(
      allOrders.map(async (order) => {
        // For one-time payments, use the total amount directly
        if (order.paymentType === "single") {
          actualTotalAmount += order.totalAmount;
        }
        // For recurring payments with Stripe, get actual payment history
        else if (
          order.paymentType === "recurring" &&
          order.transactionDetails?.stripeSubscriptionId &&
          (order.paymentMethod === "visa" ||
            order.paymentMethod === "mastercard")
        ) {
          try {
            const invoices = await stripe.invoices.list({
              subscription: order.transactionDetails.stripeSubscriptionId,
              status: "paid",
              limit: 100,
            });

            const paidAmount = invoices.data.reduce(
              (sum, invoice) => sum + invoice.amount_paid / 100,
              0
            );

            actualTotalAmount += paidAmount;
          } catch (stripeError) {
            console.error("Error fetching Stripe invoice data:", stripeError);

            // Fallback to using local payment history
            if (
              order.recurringDetails &&
              order.recurringDetails.paymentHistory &&
              order.recurringDetails.paymentHistory.length > 0
            ) {
              const paidAmount = order.recurringDetails.paymentHistory
                .filter((payment) => payment.status === "succeeded")
                .reduce((sum, payment) => sum + (payment.amount || 0), 0);

              actualTotalAmount += paidAmount;
            } else {
              // Just add one payment if active
              actualTotalAmount += order.totalAmount;
            }
          }
        }
        // For installments, count completed installments
        else if (
          order.paymentType === "installments" &&
          order.installmentDetails
        ) {
          if (
            order.installmentDetails.installmentHistory &&
            order.installmentDetails.installmentHistory.length > 0
          ) {
            const completedAmount = order.installmentDetails.installmentHistory
              .filter((payment) => payment.status === "completed")
              .reduce((sum, payment) => sum + (payment.amount || 0), 0);

            actualTotalAmount += completedAmount;
          } else {
            // Use installments paid
            actualTotalAmount +=
              (order.installmentDetails.installmentsPaid || 0) *
              (order.installmentDetails.installmentAmount || 0);
          }
        }
        // For recurring without proper tracking, use total amount
        else if (order.paymentType === "recurring") {
          actualTotalAmount += order.totalAmount;
        }
      })
    );

    // KEEP ORIGINAL RESPONSE STRUCTURE, but use adjusted total if needed
    // We don't directly show actualTotalAmount to keep the frontend working
    // but log it for admin to compare
    console.log("Reported total amount:", totalDonations[0]?.total || 0);
    console.log("Actual total amount (calculated):", actualTotalAmount);

    res.json({
      stats: {
        totalAmount: totalDonations[0]?.total || 0,
        averageDonation: totalDonations[0]
          ? totalDonations[0].total / totalDonations[0].count
          : 0,
        recurringDonations,
        successRate,
        // Add these fields, frontend can choose to use them or not
        actualTotalAmount: actualTotalAmount,
      },
    });
  } catch (error) {
    console.error("Error in getDashboardStats:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch dashboard statistics",
      error: error.message,
    });
  }
};

// Corrected getTopDonors function that keeps original response format
exports.getTopDonors = async (req, res) => {
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // KEEP ORIGINAL QUERY to avoid breaking frontend
    const topDonorsOriginal = await Order.aggregate([
      {
        $match: {
          paymentStatus: { $in: ["completed", "active"] },
        },
      },
      {
        $group: {
          _id: "$user",
          totalAmount: { $sum: "$totalAmount" },
          donationCount: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 4 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      { $unwind: "$userInfo" },
      {
        $project: {
          name: "$userInfo.name",
          email: "$userInfo.email",
          total: "$totalAmount",
          donations: "$donationCount",
          image: {
            $ifNull: ["$userInfo.profileImage", "/api/placeholder/50/50"],
          },
        },
      },
    ]);

    // Calculate actual totals for each donor and include it in a separate field
    const topDonorsWithActual = await Promise.all(
      topDonorsOriginal.map(async (donor) => {
        let actualTotal = 0;

        // Get all orders for this donor
        const userOrders = await Order.find({
          user: donor._id,
          paymentStatus: { $in: ["completed", "active"] },
        }).lean();

        // Calculate actual payment amounts
        await Promise.all(
          userOrders.map(async (order) => {
            // One-time payments
            if (order.paymentType === "single") {
              actualTotal += order.totalAmount;
            }
            // Recurring payments with Stripe
            else if (
              order.paymentType === "recurring" &&
              order.transactionDetails?.stripeSubscriptionId
            ) {
              try {
                const invoices = await stripe.invoices.list({
                  subscription: order.transactionDetails.stripeSubscriptionId,
                  status: "paid",
                  limit: 100,
                });

                const paidAmount = invoices.data.reduce(
                  (sum, invoice) => sum + invoice.amount_paid / 100,
                  0
                );

                actualTotal += paidAmount;
              } catch (error) {
                console.error(
                  `Error fetching Stripe data for donor ${donor._id}:`,
                  error
                );
                actualTotal += order.totalAmount; // Fallback
              }
            }
            // Installment payments
            else if (
              order.paymentType === "installments" &&
              order.installmentDetails
            ) {
              if (
                order.installmentDetails.installmentHistory &&
                order.installmentDetails.installmentHistory.length > 0
              ) {
                const completedAmount =
                  order.installmentDetails.installmentHistory
                    .filter((inst) => inst.status === "completed")
                    .reduce((sum, inst) => sum + (inst.amount || 0), 0);

                actualTotal += completedAmount;
              } else {
                actualTotal +=
                  (order.installmentDetails.installmentsPaid || 0) *
                  (order.installmentDetails.installmentAmount || 0);
              }
            }
            // Other recurring without proper tracking
            else if (order.paymentType === "recurring") {
              actualTotal += order.totalAmount;
            }
          })
        );

        // Add actualTotal to the donor object without changing structure
        return {
          ...donor,
          actualTotal,
        };
      })
    );

    // Log differences for admin to review
    topDonorsWithActual.forEach((donor) => {
      if (donor.total !== donor.actualTotal) {
        console.log(
          `Donor ${donor.name} reported total: ${donor.total}, actual total: ${donor.actualTotal}`
        );
      }
    });

    // Keep original response structure
    res.json({ topDonors: topDonorsOriginal });
  } catch (error) {
    console.error("Error in getTopDonors:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch top donors",
      error: error.message,
    });
  }
};

// Corrected donations formatter for getDonations function
const formatDonation = (donation) => {
  // Calculate actual amount based on payment type
  let actualAmount = donation.totalAmount;

  if (donation.paymentType === "installments" && donation.installmentDetails) {
    // For installments, show paid amount
    actualAmount =
      (donation.installmentDetails.installmentsPaid || 0) *
      (donation.installmentDetails.installmentAmount || 0);
  } else if (
    donation.paymentType === "recurring" &&
    donation.recurringDetails &&
    donation.recurringDetails.paymentHistory &&
    donation.recurringDetails.paymentHistory.length > 0
  ) {
    // For recurring with history, sum successful payments
    actualAmount = donation.recurringDetails.paymentHistory
      .filter((payment) => payment.status === "succeeded")
      .reduce((sum, payment) => sum + (payment.amount || 0), 0);
  }

  return {
    id: donation._id,
    ...donation,
    // Add computed fields for UI use:
    donor: donation.donorDetails?.name,
    email: donation.donorDetails?.email,
    amount: actualAmount, // Use calculated actual amount
    totalAmount: donation.totalAmount, // Keep original total for reference
    paidAmount: actualAmount, // Explicit field for clarity
    cause: donation.items[0]?.title || "Multiple Items",
    date: donation.createdAt,
    type: donation.paymentType,
    status: donation.paymentStatus,
    nextPaymentDate:
      donation.recurringDetails?.nextPaymentDate ||
      donation.installmentDetails?.nextInstallmentDate,
  };
};

const sendCancellationConfirmationEmail = async (donation) => {
  try {
    // Get user from the donation
    const user = await User.findById(donation.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for donation:", donation.donationId);
      return;
    }

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Subscription Cancelled</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>Your request to cancel your recurring donation has been processed.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${donation.donationId}</p>
          <p><strong>Date:</strong> ${new Date(donation.createdAt).toLocaleDateString()}</p>
          <p><strong>Amount:</strong> $${donation.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Frequency:</strong> ${donation.recurringDetails.frequency}</p>
        </div>

        <p>Your recurring donation has been cancelled and no further payments will be processed.</p>
        
        <p>Thank you for your past support!</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Subscription Cancelled - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send cancellation confirmation email:", result.error);
    } else {
      console.log("Cancellation confirmation email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending cancellation confirmation email:", error);
  }
};

exports.processCancellationRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid action. Must be 'approve' or 'reject'",
      });
    }

    const donation = await Order.findById(id);

    if (!donation) {
      return res.status(404).json({
        status: "Error",
        message: "Donation not found",
      });
    }

    if (donation.paymentStatus !== "pending_cancellation") {
      return res.status(400).json({
        status: "Error",
        message: "This donation is not pending cancellation",
      });
    }

    if (action === 'approve') {
      // If it's a Stripe subscription, cancel it in Stripe
      if (donation.transactionDetails?.stripeSubscriptionId) {
        try {
          const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
          await stripe.subscriptions.del(donation.transactionDetails.stripeSubscriptionId);
          console.log(`Cancelled Stripe subscription: ${donation.transactionDetails.stripeSubscriptionId}`);
        } catch (stripeError) {
          console.error("Error cancelling Stripe subscription:", stripeError);
          // Continue with local cancellation even if Stripe fails
        }
      }

      // Update donation status
      donation.paymentStatus = "cancelled";
      if (donation.recurringDetails) {
        donation.recurringDetails.status = "cancelled";
      }

      // Send confirmation email
      await sendCancellationConfirmationEmail(donation);
    } else {
      // Reject the cancellation request
      donation.paymentStatus = "active";
    }

    await donation.save();

    res.json({
      status: "Success",
      message: `Cancellation request ${action}ed successfully`,
      donation,
    });
  } catch (error) {
    console.error("Error processing cancellation request:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to process cancellation request",
      error: error.message,
    });
  }
};

// Update the getDonations function to highlight pending cancellations
exports.getDonations = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      status,
      type,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build filter conditions
    const filter = {};
    if (status && status !== "All") {
      filter.paymentStatus = status;
    }
    if (type && type !== "All") {
      filter.paymentType = type;
    }
    if (search) {
      filter.$or = [
        { donationId: { $regex: search, $options: "i" } },
        { "donorDetails.name": { $regex: search, $options: "i" } },
        { "donorDetails.email": { $regex: search, $options: "i" } },
      ];
    }

    // Build sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Execute query with pagination
    const donations = await Order.find(filter)
      .sort(sortConfig)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("user", "name email")
      .lean();

    // Get total count for pagination
    const total = await Order.countDocuments(filter);

    // Format donations with additional fields
    const formattedDonations = donations.map((donation) => {
      const formatted = {
        id: donation._id,
        ...donation,
        donor: donation.donorDetails?.name,
        email: donation.donorDetails?.email,
        amount: donation.totalAmount,
        cause: donation.items[0]?.title || "Multiple Items",
        date: donation.createdAt,
        type: donation.paymentType,
        status: donation.paymentStatus,
        nextPaymentDate:
          donation.recurringDetails?.nextPaymentDate ||
          donation.installmentDetails?.nextInstallmentDate,
        // Add flag for pending cancellation
        isPendingCancellation: donation.paymentStatus === "pending_cancellation",
      };

      // Add actual amount calculation
      let actualAmount = donation.totalAmount;
      if (donation.paymentType === "installments" && donation.installmentDetails) {
        if (donation.installmentDetails.installmentHistory?.length > 0) {
          actualAmount = donation.installmentDetails.installmentHistory
            .filter((payment) => payment.status === "completed")
            .reduce((sum, payment) => sum + (payment.amount || 0), 0);
        } else {
          actualAmount =
            (donation.installmentDetails.installmentsPaid || 0) *
            (donation.installmentDetails.installmentAmount || 0);
        }
      } else if (donation.paymentType === "recurring" && donation.recurringDetails) {
        if (donation.recurringDetails.paymentHistory?.length > 0) {
          actualAmount = donation.recurringDetails.paymentHistory
            .filter((payment) => payment.status === "succeeded")
            .reduce((sum, payment) => sum + (payment.amount || 0), 0);
        }
      }
      formatted.actualAmount = actualAmount;

      return formatted;
    });

    res.json({
      donations: formattedDonations,
      pagination: {
        total,
        pages: Math.ceil(total / limit),
        currentPage: Number(page),
        perPage: Number(limit),
      },
    });
  } catch (error) {
    console.error("Error in getDonations:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch donations",
      error: error.message,
    });
  }
};

// In your controller (e.g., donationController.js)
exports.getAllDonations = async (req, res) => {
  try {
    const {
      search = "",
      status,
      type,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build filter conditions
    const filter = {};
    if (status && status !== "All") {
      filter.paymentStatus = status;
    }
    if (type && type !== "All") {
      filter.paymentType = type;
    }
    // Search in donor details or donation ID
    if (search) {
      filter.$or = [
        { donationId: { $regex: search, $options: "i" } },
        { "donorDetails.name": { $regex: search, $options: "i" } },
        { "donorDetails.email": { $regex: search, $options: "i" } },
      ];
    }

    // Build sort configuration
    const sortConfig = {};
    sortConfig[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Fetch all donations without pagination
    const donations = await Order.find(filter)
      .sort(sortConfig)
      .populate("user", "name email")
      .lean();

    // Optionally, format your donations (if needed)
    const formattedDonations = donations.map((donation) => ({
      id: donation._id,
      ...donation,
      donor: donation.donorDetails?.name,
      email: donation.donorDetails?.email,
      amount: donation.totalAmount,
      cause: donation.items[0]?.title || "Multiple Items",
      date: donation.createdAt,
      type: donation.paymentType,
      status: donation.paymentStatus,
      nextPaymentDate:
        donation.recurringDetails?.nextPaymentDate ||
        donation.installmentDetails?.nextInstallmentDate,
    }));

    res.json({
      donations: formattedDonations,
    });
  } catch (error) {
    console.error("Error in getAllDonations:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch all donations",
      error: error.message,
    });
  }
};

exports.getDonationsExport = async (req, res) => {
  try {
    // Implementation for exporting donations to CSV
    // Use a library like json2csv
    const donations = await Order.find()
      .populate("user", "name email")
      .sort({ createdAt: -1 });

    // Convert to CSV and send
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=donations.csv");
    // ... implement CSV conversion and sending
  } catch (error) {
    res.status(500).json({
      status: "Error",
      message: "Failed to export donations",
      error: error.message,
    });
  }
};

exports.getDonationForUser = async (req, res) => {
  try {
    const { id } = req.params;
    const donations = await Order.find({ user: id }).lean();

    res.json({ donations });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch donations",
      error: error.message,
    });
  }
};

exports.getDonationById = async (req, res) => {
  try {
    const { id } = req.params;
    const donation = await Order.findById(id)
      .populate("user", "name email")
      .lean();

    if (!donation) {
      return res.status(404).json({
        status: "Error",
        message: "Donation not found",
      });
    }

    res.json({
      donation,
    });
  } catch (error) {
    console.error("Error fetching donation:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to fetch donation details",
      error: error.message,
    });
  }
};

const sendBankTransferApprovalEmail = async (donation) => {
  try {
    // Get user from the donation
    const user = await User.findById(donation.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for donation:", donation.donationId);
      return;
    }

    console.log("Attempting to send donation approval email to:", user.email);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Donation Approved</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We are pleased to inform you that your bank transfer donation has been approved.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${donation.donationId}</p>
          <p><strong>Date:</strong> ${new Date(donation.createdAt).toLocaleDateString()}</p>
          <p><strong>Amount:</strong> $${donation.totalAmount.toFixed(2)} AUD</p>
        </div>

        <p>You can download your tax receipt from the "My donations" page after logging in to your account.</p>
        
        <p>Thank you for your generous support!</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Donation Approved - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send donation approval email:", result.error);
      console.error("Email details:", {
        to: user.email,
        subject: "Donation Approved - Shahid Afridi Foundation",
        donationId: donation.donationId
      });
    } else {
      console.log("Donation approval email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending donation approval email:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      donationId: donation.donationId
    });
  }
};

const sendBankTransferCancellationEmail = async (donation) => {
  try {
    // Get user from the donation
    const user = await User.findById(donation.user);
    if (!user || !user.email) {
      console.error("Missing user or user email for donation:", donation.donationId);
      return;
    }

    console.log("Attempting to send donation cancellation email to:", user.email);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #dc2626;">Donation Cancelled</h2>
        
        <p>Dear ${user.name},</p>
        
        <p>We regret to inform you that your bank transfer donation has been cancelled.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${donation.donationId}</p>
          <p><strong>Date:</strong> ${new Date(donation.createdAt).toLocaleDateString()}</p>
          <p><strong>Amount:</strong> $${donation.totalAmount.toFixed(2)} AUD</p>
        </div>

        <p>If you believe this is an error, please contact us at info@ShahidAfridiFoundation.org.au</p>
        
        <p>Thank you for your interest in supporting our cause.</p>
      </div>
    `;

    const result = await sendEmail(
      user.email,
      emailBody,
      "Donation Cancelled - Shahid Afridi Foundation"
    );

    if (!result.success) {
      console.error("Failed to send donation cancellation email:", result.error);
      console.error("Email details:", {
        to: user.email,
        subject: "Donation Cancelled - Shahid Afridi Foundation",
        donationId: donation.donationId
      });
    } else {
      console.log("Donation cancellation email sent successfully to:", user.email);
    }
  } catch (error) {
    console.error("Error sending donation cancellation email:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      donationId: donation.donationId
    });
  }
};

// Update donation status
exports.updateDonationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentStatus } = req.body;

    if (!paymentStatus) {
      return res.status(400).json({
        status: "Error",
        message: "Payment status is required",
      });
    }

    const validStatuses = [
      "pending",
      "processing",
      "completed",
      "failed",
      "cancelled",
    ];
    if (!validStatuses.includes(paymentStatus)) {
      return res.status(400).json({
        status: "Error",
        message: "Invalid payment status",
      });
    }

    const donation = await Order.findById(id);

    if (!donation) {
      return res.status(404).json({
        status: "Error",
        message: "Donation not found",
      });
    }

    const oldStatus = donation.paymentStatus;
    donation.paymentStatus = paymentStatus;

    // If completing a payment that was in installments or recurring, update status
    if (paymentStatus === "completed") {
      if (
        donation.paymentType === "installments" &&
        donation.installmentDetails
      ) {
        donation.installmentDetails.status = "completed";
      }

      if (donation.paymentType === "recurring" && donation.recurringDetails) {
        donation.recurringDetails.status = "completed";
      }
    }

    await donation.save();

    // Send appropriate email notifications for bank transfer donations
    if (donation.paymentMethod === "bank") {
      try {
        if (paymentStatus === "completed" && oldStatus !== "completed") {
          await sendBankTransferApprovalEmail(donation);
        } else if (paymentStatus === "cancelled" && oldStatus !== "cancelled") {
          await sendBankTransferCancellationEmail(donation);
        }
      } catch (emailError) {
        console.error("Failed to send status update email:", emailError);
      }
    }

    res.json({
      status: "Success",
      message: "Donation status updated successfully",
      donation,
    });
  } catch (error) {
    console.error("Error updating donation status:", error);
    res.status(500).json({
      status: "Error",
      message: "Failed to update donation status",
      error: error.message,
    });
  }
};
