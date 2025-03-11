// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");

router.post("/register", userController.register);
router.post("/login", userController.login);
router.post("/registerAdmin", userController.registerAdmin);
router.post("/loginAdmin", userController.loginAdmin);
router.post("/forgot-password", userController.forgotPassword);
router.post("/reset-password/:token", userController.resetPassword);
router.post('/auth/google', userController.googleAuth);

router.get("/me",  userController.getMe);
router.put("/update", userController.updateUser);
module.exports = router;
