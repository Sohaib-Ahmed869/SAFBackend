require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("./models/user");

async function run() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
  if (!mongoUri) {
    console.error("Missing MONGO_URI/MONGODB_URI in environment.");
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    const email = "testadmin@test.com";
    const plainPassword = "TestPassword123!";
    const name = "Test Admin";

    const existing = await User.findOne({ email });
    if (existing) {
      await User.deleteOne({ _id: existing._id });
      console.log(`Deleted existing user with email ${email}`);
    }

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const admin = new User({
      name,
      email,
      password: hashedPassword,
      role: "admin",
      isVerified: true,
    });

    await admin.save();
    console.log("Admin user created:", { email, password: plainPassword });

    const ok = await bcrypt.compare(plainPassword, admin.password);
    console.log("Password verify:", ok ? "OK" : "FAILED");
  } catch (err) {
    console.error("Error creating admin:", err);
  } finally {
    await mongoose.connection.close();
    console.log("MongoDB connection closed");
  }
}

run();

 