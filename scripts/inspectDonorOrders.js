/**
 * Read-only diagnostic: list every order the statement engine would see for a
 * donor (user id match OR donorDetails.email match), with the fields the FY
 * filter and duplicate checks use.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/inspectDonorOrders.js <userId> <email>
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");

const [userId, email] = process.argv.slice(2);

async function main() {
  await connectDB();

  const orders = await Order.find({
    $or: [{ user: userId }, { "donorDetails.email": email }],
  })
    .sort({ createdAt: 1 })
    .select(
      "donationId user paymentType paymentStatus totalAmount createdAt lastPaymentDate transactionDetails.bank_reference transactionDetails.source items.title"
    )
    .lean();

  console.log(`Found ${orders.length} order(s) for user=${userId} / email=${email}\n`);
  for (const o of orders) {
    console.log(
      [
        o.donationId,
        `$${o.totalAmount}`,
        o.paymentType,
        o.paymentStatus,
        `createdAt=${o.createdAt?.toISOString?.() || o.createdAt}`,
        `lastPaymentDate=${o.lastPaymentDate?.toISOString?.() || o.lastPaymentDate || "-"}`,
        `user=${o.user || "none"}`,
        `src=${o.transactionDetails?.source || "-"}`,
        `ref=${(o.transactionDetails?.bank_reference || "-").slice(0, 60)}`,
      ].join(" | ")
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
