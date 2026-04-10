const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const { upload } = require("../../config/s3");
const heroSliderController = require("../../controllers/heroSliderController");

router.get("/", isAdmin, heroSliderController.getAdminHeroSlider);
router.put("/", isAdmin, upload.any(), heroSliderController.upsertHeroSlider);

module.exports = router;
