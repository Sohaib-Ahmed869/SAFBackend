const mongoose = require("mongoose");

const goFundMeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      required: [true, "Description is required"],
      trim: true,
      maxlength: 2000,
    },
    personalStory: {
      type: String,
      required: [true, "Personal story is required"],
      trim: true,
      maxlength: 3000,
    },
    financialSituation: {
      type: String,
      required: [true, "Financial situation is required"],
      trim: true,
      maxlength: 1500,
    },
    reasonForFunding: {
      type: String,
      required: [true, "Reason for funding is required"],
      trim: true,
      maxlength: 1500,
    },
    targetAmount: {
      type: Number,
      required: [true, "Target amount is required"],
      min: 100,
      max: 1000000,
    },
    currentAmount: {
      type: Number,
      default: 0,
    },
    image: {
      type: String,
      required: [true, "Image is required"],
    },
    imagePath: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "completed", "deactivated"],
      default: "pending",
    },
    adminNotes: {
      type: String,
      trim: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    slug: {
      type: String,
      unique: true,
      sparse: true,
    },
    donationCount: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    category: {
      type: String,
      // enum: [
      //   "medical",
      //   "education",
      //   "emergency",
      //   "community",
      //   "personal",
      //   "food",
      //   "water",

      //   "other",
      // ],
      required: true,
    },
    urgencyLevel: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
  },
  {
    timestamps: true,
  }
);

// Create slug before saving
goFundMeSchema.pre("save", function (next) {
  if (this.isModified("title") && !this.slug) {
    this.slug =
      this.title
        .toLowerCase()
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") +
      "-" +
      Date.now();
  }
  next();
});

module.exports = mongoose.model("GoFundMe", goFundMeSchema);
