const express = require("express");
const router = express.Router();
const dynamicPageController = require("../controllers/dynamicPageController");

// /nav must be declared before /:slug so it is not captured as a slug.
router.get("/nav", dynamicPageController.getNavPages);
router.get("/:slug", dynamicPageController.getPageBySlug);

module.exports = router;
