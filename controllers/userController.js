// controllers/userController.js
const User = require("../models/user");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { sendEmail } = require("../services/emailUtil");

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    console.log(req.body);
    const existingUser = await User.findOne({
      email,
    });
    if (existingUser) {
      throw new Error("User already exists");
    }

    //hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const user = new User({
      name,
      email,
      password: hashedPassword,
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);
    // Send response
    res.status(201).json({
      status: "Success",
      message: "Registration successful",
      user: {
        _id: user._id,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
      },
      token,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      status: "Error",
      message: "Registration failed",
      error: error.message,
    });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      throw new Error("Invalid login credentials");
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      throw new Error("Invalid login credentials");
    }

    res.json({
      _id: user._id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
};

exports.registerAdmin = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existingUser = await User.findOne({
      email,
    });
    if (existingUser) {
      throw new Error("User already exists");
    }

    //hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: "admin",
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);
    // Send response
    res.status(201).json({
      status: "Success",
      message: "Admin registration successful",

      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    console.error("Admin registration error:", error);
    res.status(500).json({
      status: "Error",
      message: "Admin registration failed",
      error: error.message,
    });
  }
};

exports.loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      throw new Error("Invalid login credentials");
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      throw new Error("Invalid login credentials");
    }

    if (user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        status: "Error",
        message: "No user found with that email address",
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; // Token expires in 1 hour

    // Save hashed version of token to database
    user.resetPasswordToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    user.resetPasswordExpires = resetTokenExpiry;
    await user.save();

    // Create reset URL
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    // Email content
    const emailBody = `
      You are receiving this email because you (or someone else) requested a password reset for your account.\n\n
      Please click on the following link to reset your password:\n\n
      ${resetUrl}\n\n
      This link will expire in 1 hour.\n\n
      If you did not request this, please ignore this email and your password will remain unchanged.
    `;

    await sendEmail(user.email, emailBody, "Password Reset Request");

    res.status(200).json({
      status: "Success",
      message: "Password reset link sent to email",
    });
  } catch (error) {
    console.error("Password reset request error:", error);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.status(500).json({
      status: "Error",
      message: "Error sending password reset email",
      error: error.message,
    });
  }
};

// Reset password with token
exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    // Hash the token to compare with stored hash
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Find user with valid token
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        status: "Error",
        message: "Password reset token is invalid or has expired",
      });
    }

    // Set new password
    const hashedPassword = await bcrypt.hash(password, 10);
    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Send confirmation email
    const emailBody = `
      Your password has been successfully reset.\n\n
      If you did not perform this action, please contact our support team immediately.
    `;

    await sendEmail(user.email, emailBody, "Password Reset Successful");

    res.status(200).json({
      status: "Success",
      message: "Password reset successful",
    });
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({
      status: "Error",
      message: "Error resetting password",
      error: error.message,
    });
  }
};
