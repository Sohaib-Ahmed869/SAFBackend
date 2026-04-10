const mongoose = require("mongoose");

const heroSlideSchema = new mongoose.Schema(
  {
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    sequence: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const heroSliderSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "home-hero",
      unique: true,
      index: true,
    },
    slides: {
      type: [heroSlideSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HeroSlider", heroSliderSchema);
