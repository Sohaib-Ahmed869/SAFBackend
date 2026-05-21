const express = require("express");
const router = express.Router();
const isAdmin = require("../../middleware/isAdmin");
const { dynamicPageUpload } = require("../../config/s3");
const dynamicPageController = require("../../controllers/admin/dynamicPageController");

router.get("/", isAdmin, dynamicPageController.listPages);
router.get("/:id", isAdmin, dynamicPageController.getPage);
router.post(
  "/",
  isAdmin,
  dynamicPageUpload.any(),
  dynamicPageController.createPage
);
router.put(
  "/:id",
  isAdmin,
  dynamicPageUpload.any(),
  dynamicPageController.updatePage
);
router.delete("/:id", isAdmin, dynamicPageController.deletePage);

module.exports = router;
