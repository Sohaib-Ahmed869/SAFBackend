// Contact Request Model
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const contactRequestSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    purpose: {
      type: String,
      required: true,
    },
    hostCity: {
      type: String,
      required: true,
    },
    wouldLikeToHostShahidAfridi: {
      type: Boolean,
      default: false,
    },
    businessDetails: {
      type: String,
      required: true,
    },
    numberOfGuests: {
      type: Number,
      required: true,
    },
    minimumDonationAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "reviewed", "responded"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

const ContactRequest = mongoose.model("ContactRequest", contactRequestSchema);

module.exports = ContactRequest;
