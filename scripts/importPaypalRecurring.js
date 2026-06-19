/**
 * IMPORT: commit the JSON produced by exportPaypalRecurring.js into the database.
 * This is the ONLY script here that writes. It is idempotent and append-only:
 *   - If no order exists for a subscription id, it inserts the order.
 *   - If one already exists, it appends only history entries whose invoiceId is
 *     not already present. Nothing is ever deleted or overwritten.
 *
 * Always dry-run first to see exactly what would change.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/importPaypalRecurring.js scripts/backfill-output/paypal-backfill-XXXX.json --dry-run
 *   node scripts/importPaypalRecurring.js scripts/backfill-output/paypal-backfill-XXXX.json
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");
const {
  findRecurringOrderBySubscriptionId,
} = require("../controllers/paypalController");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const filePath = argv.find((a) => !a.startsWith("--"));

async function importSubscription(entry) {
  const { subscriptionId, order } = entry;
  const incoming = order.recurringDetails?.paymentHistory || [];

  const existing = await findRecurringOrderBySubscriptionId(subscriptionId);

  if (!existing) {
    console.log(
      `* ${subscriptionId}: NO existing order -> INSERT new order ` +
        `${order.donationId} with ${incoming.length} payment(s)` +
        (DRY_RUN ? " [dry-run, not written]" : "")
    );
    if (!DRY_RUN) {
      const doc = new Order(order); // Mongoose casts dates/types and validates
      await doc.save();
      console.log(`  inserted _id=${doc._id}`);
    }
    return { inserted: !DRY_RUN ? 1 : 0, appended: 0 };
  }

  // Order exists: append only history entries we don't already have.
  if (!existing.recurringDetails) {
    console.log(`* ${subscriptionId}: existing order has no recurringDetails, skipping`);
    return { inserted: 0, appended: 0 };
  }
  if (!Array.isArray(existing.recurringDetails.paymentHistory)) {
    existing.recurringDetails.paymentHistory = [];
  }
  const have = new Set(
    existing.recurringDetails.paymentHistory.map((p) => p.invoiceId).filter(Boolean)
  );
  const toAdd = incoming.filter((p) => p.invoiceId && !have.has(p.invoiceId));

  console.log(
    `* ${subscriptionId}: existing order ${existing.donationId} -> ` +
      `${toAdd.length} new payment(s) to append (of ${incoming.length})` +
      (DRY_RUN ? " [dry-run, not written]" : "")
  );

  if (toAdd.length > 0 && !DRY_RUN) {
    existing.recurringDetails.paymentHistory.push(...toAdd);
    existing.recurringDetails.paymentHistory.sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    existing.recurringDetails.totalPayments =
      existing.recurringDetails.paymentHistory.length;
    existing.recurringDetails.lastPaymentDate =
      existing.recurringDetails.paymentHistory[
        existing.recurringDetails.paymentHistory.length - 1
      ]?.date;
    existing.markModified("recurringDetails");
    await existing.save();
  }
  return { inserted: 0, appended: !DRY_RUN ? toAdd.length : 0 };
}

async function main() {
  if (!filePath) {
    console.error("Pass the JSON file path produced by exportPaypalRecurring.js.");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const subs = data.subscriptions || [];
  console.log(
    `Loaded ${subs.length} subscription(s) from ${filePath}` +
      (DRY_RUN ? " [DRY RUN — no writes]" : "") +
      "\n"
  );

  await connectDB();

  let inserted = 0;
  let appended = 0;
  for (const entry of subs) {
    const r = await importSubscription(entry);
    inserted += r.inserted;
    appended += r.appended;
  }

  console.log(
    `\nDone. ${DRY_RUN ? "Would insert/append" : "Inserted"} ` +
      `${inserted} order(s), appended ${appended} payment(s).`
  );
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Import failed:", err.message || err);
  process.exit(1);
});
