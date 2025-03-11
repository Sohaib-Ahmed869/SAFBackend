require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");

// Import routes
const userRoutes = require("./routes/userRoutes");
const orderRoutes = require("./routes/orderRoutes");
const contactRoutes = require("./routes/contactRoutes");
const eventRoutes = require("./routes/eventRoutes");
const newsletterRoutes = require("./routes/newsletterRoutes");
const subscriptionRoutes = require("./routes/subscription");
const paymentMethodRoutes = require("./routes/paymentMethodRoutes");
const profileRoutes = require("./routes/profileRoutes");
const adminOrderRoutes = require("./routes/admin/order.routes");
const donorController = require("./controllers/admin/donorController");
const subscriptionRoutesAdmin = require("./routes/admin/subscription.routes");
const eventRoutesAdmin = require("./routes/admin/event.routes");
const joinRoutes = require("./routes/joinRoutes");
const newsLetter = require("./models/newsletter");
const setupInstallmentProcessingJob = require("./jobs/processInstallments");
const app = express();

// Connect to database
connectDB();
setupInstallmentProcessingJob();
// Middleware
app.use(
  cors({
    // origin: "https://saf.calcite.live"
    origin:"*"
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API is running...");
});
// Routes
app.use("/api/users", userRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/payment-methods", paymentMethodRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/admin/orders", adminOrderRoutes);
app.use("/api/admin/donors", donorController);
app.use("/api/admin/subscriptions", subscriptionRoutesAdmin);
app.use("/api/admin/events", eventRoutesAdmin);
app.use("/api/join", joinRoutes);
app.post("/api/newsletter", async (req, res) => {
  const { email } = req.body;
  const existingSubscriber = await newsLetter.findOne({ email });
  if (existingSubscriber) {
    return res.status(400).json({ message: "You are already subscribed" });
  }
  const subscriber = await newsLetter.create({ email });
  subscriber.save();
  return res
    .status(201)
    .json({ message: "You have been subscribed successfully" });
});
app.get("/api/newsletters", async (req, res) => {
  const subscribers = await newsLetter.find();
  res.json(subscribers);
});

// Error handling
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
