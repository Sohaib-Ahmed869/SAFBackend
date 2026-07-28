/**
 * Repair step for backfillAmmadPaypalFY2425.js: Mongoose marks createdAt
 * immutable when timestamps are enabled, so the script's updateOne silently
 * dropped the backdate and the 8 backfilled orders kept "now" as createdAt.
 * This sets createdAt/updatedAt through the native driver, matching ONLY the
 * backfilled orders by their PayPal transaction id.
 *
 * Usage (from SAFBackend-1/): node scripts/fixBackfillDates.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");

const DATES = [
  { txn: "5E69051890119704E", date: "2024-08-08T00:49:17.000Z" },
  { txn: "3SR51322K99789303", date: "2024-09-04T06:53:29.000Z" },
  { txn: "9RX46991C17634339", date: "2024-12-10T10:15:41.000Z" },
  { txn: "0EE43532US522631D", date: "2024-12-19T09:17:50.000Z" },
  { txn: "4XY184336W407632V", date: "2024-12-25T00:54:21.000Z" },
  { txn: "1DW2923952514354E", date: "2025-01-09T09:52:44.000Z" },
  { txn: "87877334LJ6756328", date: "2025-01-25T08:57:33.000Z" },
  { txn: "2DM404134H657511V", date: "2025-03-07T13:05:22.000Z" },
];

async function main() {
  await connectDB();

  for (const { txn, date } of DATES) {
    const when = new Date(date);
    const res = await Order.collection.updateOne(
      {
        "transactionDetails.paypal_transaction_id": txn,
        "transactionDetails.source": "paypal-activity-backfill-fy2024-25",
      },
      { $set: { createdAt: when, updatedAt: when } }
    );
    console.log(
      `${txn} -> ${date}: matched=${res.matchedCount} modified=${res.modifiedCount}`
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
