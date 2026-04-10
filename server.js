require("dotenv").config({ override: true });


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
const heroSliderAdminRoutes = require("./routes/admin/heroSlider.routes");
const joinRoutes = require("./routes/joinRoutes");
const newsLetter = require("./models/newsletter");
const productRoutes = require("./routes/productRoutes");
const donationtyperoute = require("./routes/donationtyperoute");
const goFundMeRoutes = require("./routes/goFundMeRoutes");
const paypalRoutes = require("./routes/paypalRoutes");
const heroSliderRoutes = require("./routes/heroSliderRoutes");
const fs = require("fs");
const path = require("path");
const setupInstallmentProcessingJob = require("./jobs/processInstallments");
const {
  scheduleSubscriptionChecks,
} = require("./services/subscriptionScheduler");
const app = express();

const Order = require("./models/order");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Determine allowed origins
const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://shahidafridifoundation.org.au",
  "https://www.shahidafridifoundation.org.au",
  "https://backend.shahidafridifoundation.org.au",
];

const envOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  : [];

const allowedOrigins = Array.from(
  new Set([...defaultOrigins, ...envOrigins].filter(Boolean))
);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests or same-origin
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
  ],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
};

// Trust reverse proxy (required for secure cookies behind load balancers)
app.set("trust proxy", 1);

// Connect to database
connectDB();
setupInstallmentProcessingJob();
scheduleSubscriptionChecks();
// Middleware
// app.use(cors({ origin: '*' }));

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Ensure credentials header is always sent
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});
app.use("/api/gofundme/webhook", express.raw({ type: "application/json" }));
app.use("/api/subscriptions/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API is running...");
});
// Ensure uploads directory exists
const uploadsBaseDir = path.join(__dirname, "public/uploads");
const uploadsProductsDir = path.join(uploadsBaseDir, "products");

[uploadsBaseDir, uploadsProductsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Make uploads directory publicly accessible
app.use(
  "/uploads",
  express.static(path.join(__dirname, "public/uploads"), {
    setHeaders: (res, path) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

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
app.use("/api/admin/hero-slider", heroSliderAdminRoutes);
app.use("/api/join", joinRoutes);
app.use("/api/products", productRoutes);
app.use("/api/donationtypes", donationtyperoute);
app.use("/api/paypal", paypalRoutes);
app.use("/api/gofundme", goFundMeRoutes);
app.use("/api/hero-slider", heroSliderRoutes);
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

const PORT = process.env.PORT || 5001; // Changed from 5000 to 5001
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
