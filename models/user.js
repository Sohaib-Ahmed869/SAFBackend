// models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,

      minlength: 6,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    defaultPaymentMethod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentMethod",
    },
    firstName: String,
    lastName: String,
    phone: {
      type: String,
      default: "+61", 
    },    
    country: String,
    language: String,
    currency: String,
    profileImage: String,
    address: {
      street: String,
      city: String,
      state: String,
      postalCode: String,
    },

    notifications: {
      emailNotifications: { type: Boolean, default: true },
      donationReceipts: { type: Boolean, default: true },
      monthlyNewsletter: { type: Boolean, default: true },
      impactUpdates: { type: Boolean, default: true },
    },

    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: String,
    passwordLastChanged: { type: Date, default: Date.now },
    tokenVersion: { type: Number, default: 0 },
    resetCode: String,
    current_status: {
      type: String,
      enum: ["online", "offline"],
      default: "offline",
    },
    lastLogin: Date,
    dateOfBirth: Date,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    isTemporaryPassword: {
      type: Boolean,
      default: false
    },
    // Set for admin-created donor records with no known email address. The
    // stored email is a generated placeholder — never send mail to it.
    isPlaceholderEmail: {
      type: Boolean,
      default: false,
    },
    // Donor record created manually from the admin panel (off-site donor).
    // The admin donors list includes these even before any donation is synced,
    // since that list is otherwise derived from orders.
    createdByAdmin: {
      type: Boolean,
      default: false,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
  },

  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
