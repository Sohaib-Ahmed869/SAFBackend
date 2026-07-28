/**
 * READ-ONLY: verify the FY24-25 backfill for ammadmansoor@hotmail.com by running
 * the same query generateStatement uses (orderContrller.js) for 2024-2025.
 *
 * Usage (from SAFBackend-1/): node scripts/verifyAmmadFY2425.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");
const User = require("../models/user");

async function main() {
  await connectDB();

  const user = await User.findOne({ email: "ammadmansoor@hotmail.com" });

  // Mirrors generateStatement for financialYear=2024-2025
  const startDate = new Date(2024, 6, 1);
  const endDate = new Date(2025, 5, 30, 23, 59, 59);

  const orders = await Order.find({
    user: user._id,
    paymentStatus: { $ne: "failed" },
    $or: [
      { createdAt: { $gte: startDate, $lte: endDate } },
      {
        paymentType: "recurring",
        "recurringDetails.paymentHistory": {
          $elemMatch: { date: { $gte: startDate, $lte: endDate } },
        },
      },
      {
        paymentType: "installments",
        "installmentDetails.installmentHistory": {
          $elemMatch: { date: { $gte: startDate, $lte: endDate } },
        },
      },
    ],
  }).sort({ createdAt: 1 });

  console.log(`FY 2024-2025 statement query returns ${orders.length} orders:\n`);
  let total = 0;
  for (const o of orders) {
    total += o.totalAmount;
    console.log(
      `  ${o.createdAt.toISOString()}  ${o.donationId}  ${o.paymentMethod.padEnd(6)} ` +
        `AUD ${o.totalAmount.toFixed(2).padStart(8)}  ${o.items[0]?.title}  ` +
        `txn=${o.paypalDetails?.paymentId || "-"}`
    );
  }
  console.log(`\n  TOTAL: AUD ${total.toFixed(2)}  (expected 3594.40)`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
