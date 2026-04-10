const HeroSlider = require("../models/heroSlider");
const { deleteS3Object } = require("../config/s3");

const SLIDER_KEY = "home-hero";

const normalizeSlides = (slides = []) =>
  [...slides]
    .filter((slide) => slide?.imageUrl)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

const extractS3KeyFromUrl = (url = "") => {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (error) {
    return null;
  }
};

exports.getPublicHeroSlider = async (_req, res) => {
  try {
    const config = await HeroSlider.findOne({ key: SLIDER_KEY }).lean();
    const slides = normalizeSlides(config?.slides || []);

    return res.json({
      success: true,
      data: {
        slides,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch hero slider configuration",
      error: error.message,
    });
  }
};

exports.getAdminHeroSlider = async (_req, res) => {
  try {
    const config = await HeroSlider.findOne({ key: SLIDER_KEY }).lean();
    const slides = normalizeSlides(config?.slides || []);

    return res.json({
      success: true,
      data: {
        slides,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch hero slider configuration",
      error: error.message,
    });
  }
};

exports.upsertHeroSlider = async (req, res) => {
  try {
    const existingConfig = await HeroSlider.findOne({ key: SLIDER_KEY });
    const existingSlides = existingConfig?.slides || [];

    let slidesPayload = [];
    try {
      slidesPayload = JSON.parse(req.body.slides || "[]");
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: "Invalid slides payload format",
      });
    }

    if (!Array.isArray(slidesPayload) || slidesPayload.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one slide is required",
      });
    }

    const nextSlides = [];
    for (let i = 0; i < slidesPayload.length; i += 1) {
      const payloadSlide = slidesPayload[i] || {};
      const fileField = `image_${i}`;
      const matchedFile = (req.files || []).find(
        (file) => file.fieldname === fileField
      );
      const imageUrl = matchedFile?.location || payloadSlide.imageUrl || "";
      const sequence = Number(payloadSlide.sequence) || i + 1;

      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          message: `Image is required for slide ${i + 1}`,
        });
      }

      nextSlides.push({
        imageUrl,
        sequence,
      });
    }

    const removedImages = existingSlides
      .map((slide) => slide.imageUrl)
      .filter((existingUrl) => !nextSlides.some((s) => s.imageUrl === existingUrl));

    for (const removedImageUrl of removedImages) {
      if (
        removedImageUrl &&
        process.env.S3_BUCKET_NAME &&
        removedImageUrl.includes(process.env.S3_BUCKET_NAME)
      ) {
        const key = extractS3KeyFromUrl(removedImageUrl);
        if (key) {
          await deleteS3Object(key);
        }
      }
    }

    const saved = await HeroSlider.findOneAndUpdate(
      { key: SLIDER_KEY },
      {
        $set: {
          key: SLIDER_KEY,
          slides: normalizeSlides(nextSlides),
        },
      },
      { new: true, upsert: true, runValidators: true }
    );

    return res.json({
      success: true,
      message: "Hero slider updated successfully",
      data: {
        slides: normalizeSlides(saved.slides || []),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update hero slider",
      error: error.message,
    });
  }
};
