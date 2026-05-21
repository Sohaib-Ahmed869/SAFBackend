const mongoose = require("mongoose");

// A single content section rendered below the page header.
const sectionSchema = new mongoose.Schema(
  {
    heading: { type: String, trim: true, default: "" },
    text: { type: String, trim: true, default: "" },
    imageUrl: { type: String, trim: true, default: "" },
    imagePath: { type: String, trim: true, default: "" }, // S3 key, kept for cleanup
    imagePosition: { type: String, enum: ["left", "right"], default: "left" },
  },
  { _id: false }
);

const dynamicPageSchema = new mongoose.Schema(
  {
    // Internal/admin-facing name.
    title: { type: String, required: true, trim: true },
    // URL slug — page is served at /page/:slug on the frontend.
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Public header shown below the slider.
    header: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    // Call-to-action button overlaid on the slider.
    cta: {
      label: { type: String, default: "", trim: true },
      url: { type: String, default: "", trim: true },
      openInNewTab: { type: Boolean, default: false },
    },
    // Repeatable rich content sections.
    sections: { type: [sectionSchema], default: [] },
    // Where (if anywhere) this page appears in the public navbar.
    navPlacement: {
      type: {
        type: String,
        enum: ["topLevel", "dropdown", "none"],
        default: "none",
      },
      dropdownParent: { type: String, default: "" }, // e.g. "Islamic Giving"
      label: { type: String, default: "" },
    },
    // Visibility window. Null = unbounded on that end.
    showFrom: { type: Date, default: null },
    showUntil: { type: Date, default: null },
    // Manual on/off switch, independent of the schedule.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DynamicPage", dynamicPageSchema);
