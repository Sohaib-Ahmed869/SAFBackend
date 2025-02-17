// models/Order.js
const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    items: [
      {
        title: {
          type: String,
          required: true,
        },
        price: {
          type: Number,
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          default: 1,
        },
        onBehalfOf: String,
      },
    ],
    paymentType: {
      type: String,
      enum: ["single", "recurring", "installments"],
      required: true,
    },
    adminCostContribution: {
      included: {
        type: Boolean,
        default: false,
      },
      amount: {
        type: Number,
        default: 0,
      },
    },
    donorDetails: {
      name: {
        type: String,
        required: true,
      },
      phone: {
        type: String,
        required: true,
      },
      email: {
        type: String,
        required: true,
      },
      address: {
        street: String,
        city: String,
        state: String,
        postcode: String,
      },
      agreeToMessages: {
        type: Boolean,
        default: false,
      },
    },
    paymentMethod: {
      type: String,
      enum: ["card", "apple-google", "paypal", "bank"],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "active",
        "paused",
        "failed",
        "cancelled",
      ],
      default: "pending",
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    donationId: {
      type: String,
      required: true,
      unique: true,
    },
    installmentDetails: {
      numberOfInstallments: Number,
      frequency: String,
      amount: Number,
      startDate: Date,
    },
    recurringDetails: {
      frequency: String,
      amount: Number,
      startDate: Date,
      endDate: Date,
    },
    transactionDetails: {
      transactionId: String,
      provider: String,
      status: String,
      timestamp: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Generate unique donation ID before saving
orderSchema.pre("save", async function (next) {
  if (this.isNew) {
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const randomNum = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    this.donationId = `D${year}${month}${randomNum}`;
  }
  next();
});

module.exports = mongoose.model("Order", orderSchema);
