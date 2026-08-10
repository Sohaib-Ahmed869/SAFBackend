/**
 * Repair step for the admin donation-sync upload (services/paypalDonationSync.js):
 * commitForUser backdated createdAt with a Mongoose updateOne, but timestamps
 * mark createdAt immutable, so the backdate was silently dropped and synced
 * orders kept the upload day as createdAt. That put them in the wrong financial
 * year (and hid the real FY from the statement dropdown, which is derived from
 * createdAt). Same bug as scripts/fixBackfillDates.js.
 *
 * Every synced one-time order stored the true payment time in lastPaymentDate
 * at insert, so this script finds donation-sync orders whose createdAt disagrees
 * with lastPaymentDate and moves createdAt/updatedAt back through the native
 * driver (which bypasses the immutability check).
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/fixDonationSyncDates.js           # dry run — prints what would change
 *   node scripts/fixDonationSyncDates.js --apply   # actually update the orders
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");

const APPLY = process.argv.includes("--apply");
const TOLERANCE_MS = 60 * 1000; // ignore sub-minute save-vs-stamp jitter

async function main() {
  await connectDB();

  const orders = await Order.find({
    "transactionDetails.source": {
      $in: ["donation-sync-template", "donation-sync-file", "donation-sync-paypal"],
    },
  })
    .select("donationId createdAt lastPaymentDate totalAmount paymentMethod user")
    .lean();

  console.log(`Found ${orders.length} donation-sync order(s).`);

  let fixed = 0;
  for (const o of orders) {
    if (!o.lastPaymentDate) {
      console.log(`  ${o.donationId}: no lastPaymentDate — skipping (inspect manually)`);
      continue;
    }
    const drift = Math.abs(new Date(o.createdAt) - new Date(o.lastPaymentDate));
    if (drift <= TOLERANCE_MS) continue; // already correct

    const when = new Date(o.lastPaymentDate);
    console.log(
      `  ${o.donationId} ($${o.totalAmount} ${o.paymentMethod}): ` +
        `createdAt ${new Date(o.createdAt).toISOString()} -> ${when.toISOString()}` +
        (APPLY ? "" : " (dry run)")
    );
    if (APPLY) {
      const res = await Order.collection.updateOne(
        { _id: o._id },
        { $set: { createdAt: when, updatedAt: when } }
      );
      if (res.modifiedCount === 1) fixed++;
    }
  }

  console.log(
    APPLY
      ? `Done — ${fixed} order(s) updated.`
      : "Dry run complete. Re-run with --apply to write the changes."
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
