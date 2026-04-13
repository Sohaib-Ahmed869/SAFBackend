const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const { heroSliderUpload } = require("../../config/s3");
const heroSliderController = require("../../controllers/heroSliderController");

router.get("/", isAdmin, heroSliderController.getAdminHeroSlider);
router.put("/", isAdmin, heroSliderUpload.any(), heroSliderController.upsertHeroSlider);

module.exports = router;
