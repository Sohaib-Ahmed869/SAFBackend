const express = require("express");
const router = express.Router();
const heroSliderController = require("../controllers/heroSliderController");

router.get("/", heroSliderController.getPublicHeroSlider);

module.exports = router;
