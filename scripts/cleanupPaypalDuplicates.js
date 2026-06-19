/**
 * One-off cleanup after the PayPal recurring backfill:
 *   1. Delete the duplicate order DON-...190 (subscription I-C3VCK0SLN41A) that was
 *      created because the import couldn't see the legacy order 95954977 (which
 *      stored the subscription id under paypalDetails.paymentId). No charge is lost
 *      — the legacy order is reconciled separately with all 6 charges.
 *   2. Link the orphan order DON-...680 (subscription I-0RYAFMPT1BPY) to Syed Atif
 *      Faheem's user account so it shows in his dashboard.
 *
 * Read-only unless run without --dry-run. Targets specific _ids only.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/cleanupPaypalDuplicates.js --dry-run
 *   node scripts/cleanupPaypalDuplicates.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

// Duplicate import order to delete (subscription I-C3VCK0SLN41A).
const DUPLICATE_ORDER_ID = "6a35053b45e9eb8b9495f441"; // DON-1781859462759-190
const DUPLICATE_SUBSCRIPTION = "I-C3VCK0SLN41A";

// Orphan import order to link to the donor (subscription I-0RYAFMPT1BPY).
const ORPHAN_ORDER_ID = "6a35053b45e9eb8b9495f43d"; // DON-1781859460866-680
const ORPHAN_SUBSCRIPTION = "I-0RYAFMPT1BPY";
const DONOR_USER_ID = "67d8b429984214ea89b29595"; // Syed Atif Faheem

async function main() {
  await connectDB();

  // --- 1. Delete the duplicate, with safety checks ---
  const dup = await Order.findById(DUPLICATE_ORDER_ID);
  if (!dup) {
    console.log(`Duplicate ${DUPLICATE_ORDER_ID} not found (already removed?).`);
  } else {
    const dupSub =
      dup.transactionDetails?.subscription_id ||
      dup.recurringDetails?.paypalSubscriptionId;
    if (dupSub !== DUPLICATE_SUBSCRIPTION) {
      console.error(
        `ABORT: ${DUPLICATE_ORDER_ID} subscription is ${dupSub}, expected ${DUPLICATE_SUBSCRIPTION}.`
      );
      process.exit(1);
    }
    // Confirm a legacy order for the same subscription still exists, so we never
    // delete the only copy.
    const survivor = await Order.findOne({
      _id: { $ne: dup._id },
      paymentMethod: "paypal",
      $or: [
        { "paypalDetails.paymentId": DUPLICATE_SUBSCRIPTION },
        { "paypalDetails.subscriptionId": DUPLICATE_SUBSCRIPTION },
        { "recurringDetails.paypalSubscriptionId": DUPLICATE_SUBSCRIPTION },
        { "transactionDetails.subscription_id": DUPLICATE_SUBSCRIPTION },
      ],
    });
    if (!survivor) {
      console.error(
        `ABORT: no other order found for ${DUPLICATE_SUBSCRIPTION}; refusing to delete the only copy.`
      );
      process.exit(1);
    }
    console.log(
      `Delete duplicate ${dup.donationId} (${DUPLICATE_ORDER_ID}); ` +
        `survivor is ${survivor.donationId} (${survivor._id})` +
        (DRY_RUN ? " [dry-run]" : "")
    );
    if (!DRY_RUN) {
      await Order.deleteOne({ _id: dup._id });
      console.log("  deleted.");
    }
  }

  // --- 2. Link the orphan order to the donor ---
  const orphan = await Order.findById(ORPHAN_ORDER_ID);
  if (!orphan) {
    console.log(`Orphan ${ORPHAN_ORDER_ID} not found.`);
  } else {
    const orphanSub =
      orphan.transactionDetails?.subscription_id ||
      orphan.recurringDetails?.paypalSubscriptionId;
    if (orphanSub !== ORPHAN_SUBSCRIPTION) {
      console.error(
        `ABORT: ${ORPHAN_ORDER_ID} subscription is ${orphanSub}, expected ${ORPHAN_SUBSCRIPTION}.`
      );
      process.exit(1);
    }
    console.log(
      `Link ${orphan.donationId} (${ORPHAN_ORDER_ID}) -> user ${DONOR_USER_ID} ` +
        `(was ${orphan.user || "null"})` +
        (DRY_RUN ? " [dry-run]" : "")
    );
    if (!DRY_RUN) {
      orphan.user = new mongoose.Types.ObjectId(DONOR_USER_ID);
      await orphan.save();
      console.log("  linked.");
    }
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Cleanup failed:", err.message || err);
  process.exit(1);
});
