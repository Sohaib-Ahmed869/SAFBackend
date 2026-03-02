const express = require("express");
const router = express.Router();
const joinController = require("../controllers/joinTeamController");

router.post("/", joinController.createJoin);
router.get("/", joinController.getAllJoin);
router.delete("/:id", joinController.deleteJoin);

module.exports = router;
