// controllers/userController.js
const User = require("../models/user");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { sendEmail } = require("../services/emailUtil");

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
};

exports.register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, country, phone } = req.body;
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
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email,
      password: hashedPassword,
      country,
      phone,
    });

    await user.save();

    console.log("User SignUp", user);
    // Generate token
    const token = generateToken(user._id);
    // Send response
    res.status(201).json({
      status: "Success",
      message: "Registration successful",
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        address: user.address,
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
      address: user.address,
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
      role: user.role,
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    console.log(email);
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
    const resetUrl = `https://shahidafridifoundation.org.au/reset-password/${resetToken}`;

    // Email content
    const emailBody = `
     <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
  
  <h2 style="color: #4CAF50; text-align: center;">Password Reset Request</h2>
  
  <p>Dear Valued Member,</p>
  
  <p>We received a request to reset your password for your Shahid Afridi Foundation account. To complete the process and set a new password, please click the button below:</p>
  
  <div style="text-align: center; margin: 30px 0;">
    <a href="${resetUrl}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reset Your Password</a>
  </div>
  
  <p>This link will expire in 1 hour for security reasons.</p>
  
  <p>If you didn't request this password reset, please ignore this email or contact our support team if you have concerns about your account security.</p>
  
  <p>Warm regards,<br>The Shahid Afridi Foundation Team</p>
  
  <div style="font-size: 12px; color: #666; border-top: 1px solid #e0e0e0; margin-top: 20px; padding-top: 20px;">
    <p>This is an automated email. Please do not reply to this message.</p>
    <p>If you're having trouble with the button above, copy and paste this link into your browser: ${resetUrl}</p>
  </div>
</div>
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

exports.googleAuth = async (req, res) => {
  try {
    const token = req.body.credential;
    console.log("Received token:", token);
    if (!token) {
      return res.status(400).json({
        status: "Error",
        message: "No ID token provided",
      });
    }

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const fullName = payload.name;
    let firstName = "";
    let lastName = "";
    if (fullName) {
      const names = fullName.split(" ");
      firstName = names[0];
      lastName = names.slice(1).join(" ");
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        firstName,
        lastName,
        name: fullName,
        email,
        authProvider: "google",
        googleId,
        profileImage: payload.picture,
      });
      await user.save();
    } else {
      if (!user.googleId) {
        user.googleId = googleId;
        user.authProvider = "google";
        if (!user.firstName) user.firstName = firstName;
        if (!user.lastName) user.lastName = lastName;
        await user.save();
      }
    }

    const jwtToken = generateToken(user._id);
    res.status(200).json({
      status: "Success",
      message: "Google Authentication successful",
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
      token: jwtToken,
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({
      status: "Error",
      message: "Google authentication failed",
      error: error.message,
    });
  }
};

exports.getMe = async (req, res) => {
  try {
    console.log(req.user);
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        status: "Error",
        message: "User not found",
      });
    }
    res.status(200).json({
      status: "Success",
      user: {
        _id: user._id,
        // Combine firstName and lastName into a single name field
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        address: user.address,
        country: user.country,
        // Include any additional fields you might need on the frontend
        agreeToMessages: user.agreeToMessages,
      },
    });
  } catch (error) {
    console.error("getMe error:", error);
    res.status(500).json({
      status: "Error",
      message: "Could not get user data",
      error: error.message,
    });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    // Destructure fields from the request body.
    const {
      firstName,
      lastName,
      email,
      phone,
      country,
      address,
      agreeToMessages,
    } = req.body;

    if (!user) {
      return res.status(404).json({
        status: "Error",
        message: "User not found",
      });
    }

    // Update basic fields if provided.
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (firstName || lastName) {
      // Update the concatenated name field.
      user.name = `${firstName || user.firstName} ${lastName || user.lastName}`;
    }
    if (phone) user.phone = phone;
    if (country) user.country = country;
    if (typeof agreeToMessages !== "undefined")
      user.agreeToMessages = agreeToMessages;

    // Update the address using the nested object (if provided)
    if (address) {
      if (!user.address) {
        user.address = {};
      }
      if (address.street) user.address.street = address.street;
      if (address.city) user.address.city = address.city;
      if (address.state) user.address.state = address.state;
    }

    await user.save();

    res.status(200).json({
      status: "Success",
      message: "User updated successfully",
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        address: user.address,
        country: user.country,
        agreeToMessages: user.agreeToMessages,
      },
    });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({
      status: "Error",
      message: "Could not update user data",
      error: error.message,
    });
  }
};

// In controllers/userController.js

exports.updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        status: "Error",
        message: "User not found",
      });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        status: "Error",
        message: "Current password is incorrect",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({
      status: "Success",
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Update password error:", error);
    res.status(500).json({
      status: "Error",
      message: "Could not update password",
      error: error.message,
    });
  }
};
