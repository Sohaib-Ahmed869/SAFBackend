const mongoose = require("mongoose");

const goFundMeDonationSchema = new mongoose.Schema(
  {
    goFundMeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GoFundMe",
      required: true,
    },
    donorName: {
      type: String,
      required: true,
      trim: true,
    },
    donorEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    message: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    isAnonymous: {
      type: Boolean,
      default: false,
    },
    stripePaymentIntentId: {
      type: String,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },
    transactionFee: {
      type: Number,
      default: 0,
    },
    netAmount: {
      type: Number,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ["stripe", "paypal", "bank_transfer", "visa", "mastercard", "amex", "discover"],
      default: "stripe",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("GoFundMeDonation", goFundMeDonationSchema);
