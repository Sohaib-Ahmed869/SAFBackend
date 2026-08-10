/**
 * BACKFILL: insert Ammad Mansoor's FY24-25 one-time PayPal donations from his
 * PayPal activity export, so the website's donation-statement endpoints
 * (GET /api/orders/statement?financialYear=2024-2025) can generate his statement.
 *
 * Idempotent: skips any transaction whose PayPal transaction ID already exists
 * on an order, and any order for this user with the same amount on the same day.
 * Nothing is ever updated or deleted — insert-only.
 *
 * Amounts are the PayPal GROSS (what the donor actually paid; PayPal's fee was
 * deducted on the charity side). createdAt is set to the original payment time
 * (converted from AEST/AEDT to UTC) via a timestamps:false update, because
 * Mongoose would otherwise stamp "now" and the statement's FY range query
 * (which filters one-time orders by createdAt) would never see these.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/backfillAmmadPaypalFY2425.js --dry-run
 *   node scripts/backfillAmmadPaypalFY2425.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");
const User = require("../models/user");

const DRY_RUN = process.argv.includes("--dry-run");

const EMAIL = "ammadmansoor@hotmail.com";

// From the donor's PayPal activity export. date = original local time already
// converted to UTC (AEST = UTC+10, AEDT = UTC+11). gross = amount the donor paid.
const DONATIONS = [
  { date: "2024-08-08T00:49:17.000Z", gross: 1618.10, fee: 18.10, net: 1600.00, txn: "5E69051890119704E", title: "Educate a Child" },
  { date: "2024-09-04T06:53:29.000Z", gross: 303.64,  fee: 3.64,  net: 300.00,  txn: "3SR51322K99789303", title: "Educate a Child" },
  { date: "2024-12-10T10:15:41.000Z", gross: 210.62,  fee: 2.62,  net: 208.00,  txn: "9RX46991C17634339", title: "Sadaqa" },
  { date: "2024-12-19T09:17:50.000Z", gross: 477.00,  fee: 5.55,  net: 471.45,  txn: "0EE43532US522631D", title: "Educate a Child" },
  { date: "2024-12-25T00:54:21.000Z", gross: 212.64,  fee: 2.64,  net: 210.00,  txn: "4XY184336W407632V", title: "Educate a Child" },
  { date: "2025-01-09T09:52:44.000Z", gross: 202.53,  fee: 2.53,  net: 200.00,  txn: "1DW2923952514354E", title: "Educate a Child" },
  { date: "2025-01-25T08:57:33.000Z", gross: 468.45,  fee: 5.45,  net: 463.00,  txn: "87877334LJ6756328", title: "Build a Small Handpump" },
  { date: "2025-03-07T13:05:22.000Z", gross: 101.42,  fee: 1.42,  net: 100.00,  txn: "2DM404134H657511V", title: "Educate a Child" },
];

const generateDonationId = () =>
  `${Math.floor(1000 + Math.random() * 9000)}${Math.floor(1000 + Math.random() * 9000)}`;

const generateUniqueDonationId = async () => {
  for (let i = 0; i < 5; i++) {
    const id = generateDonationId();
    if (!(await Order.findOne({ donationId: id }))) return id;
  }
  throw new Error("Could not generate unique donationId");
};

async function findExisting(user, d) {
  // 1) by PayPal transaction id anywhere it could have been stored
  const byTxn = await Order.findOne({
    $or: [
      { "paypalDetails.paymentId": d.txn },
      { "paypalDetails.lastPaymentId": d.txn },
      { "transactionDetails.paypal_transaction_id": d.txn },
      { externalId: d.txn },
      { "recurringDetails.paymentHistory.invoiceId": d.txn },
    ],
  });
  if (byTxn) return { order: byTxn, reason: "transaction id already present" };

  // 2) same donor, same amount, same calendar day (guards against a copy that
  //    was entered without the PayPal transaction id)
  const dayStart = new Date(new Date(d.date).getTime() - 24 * 3600 * 1000);
  const dayEnd = new Date(new Date(d.date).getTime() + 24 * 3600 * 1000);
  const byAmountDate = await Order.findOne({
    $or: [{ user: user._id }, { "donorDetails.email": EMAIL }],
    totalAmount: d.gross,
    createdAt: { $gte: dayStart, $lte: dayEnd },
  });
  if (byAmountDate)
    return { order: byAmountDate, reason: "same amount within 1 day of payment" };

  return null;
}

async function main() {
  await connectDB();

  const user = await User.findOne({ email: EMAIL });
  if (!user) {
    console.error(`User ${EMAIL} not found — aborting, nothing written.`);
    process.exit(1);
  }
  console.log(`Donor: ${user.name} <${user.email}> user=${user._id}`);
  console.log(DRY_RUN ? "MODE: dry-run (no writes)\n" : "MODE: COMMIT\n");

  let inserted = 0;
  let skipped = 0;

  for (const d of DONATIONS) {
    const existing = await findExisting(user, d);
    if (existing) {
      console.log(
        `- ${d.txn} ${d.date} AUD ${d.gross}: SKIP (${existing.reason}; ` +
          `order ${existing.order.donationId})`
      );
      skipped++;
      continue;
    }

    console.log(
      `- ${d.txn} ${d.date} AUD ${d.gross} "${d.title}": INSERT` +
        (DRY_RUN ? " [dry-run, not written]" : "")
    );
    if (DRY_RUN) continue;

    const when = new Date(d.date);
    const donationId = await generateUniqueDonationId();

    const order = new Order({
      user: user._id,
      donationId,
      items: [{ title: d.title, price: d.gross, quantity: 1 }],
      paymentType: "single",
      donationType: "Sadaqa",
      adminCostContribution: { included: false, amount: 0 },
      donorDetails: {
        name: user.name,
        phone: user.phone,
        email: user.email,
        address: {
          street: "36/6 Gungahlin Place",
          city: "Gungahlin",
          state: "ACT",
          postcode: "2912",
        },
        agreeToMessages: false,
      },
      paymentMethod: "paypal",
      paymentStatus: "completed",
      totalAmount: d.gross,
      lastPaymentDate: when,
      paypalDetails: {
        paymentId: d.txn,
        status: "COMPLETED",
        lastPaymentDate: when,
        lastPaymentId: d.txn,
        lastUpdated: when,
        paymentCompleted: true,
      },
      transactionDetails: {
        paypal_transaction_id: d.txn,
        paypal_gross: d.gross,
        paypal_fee: d.fee,
        paypal_net: d.net,
        currency: "AUD",
        source: "paypal-activity-backfill-fy2024-25",
      },
    });

    await order.save();
    // Mongoose timestamps stamped "now" on save; move both back to the real
    // payment time so FY-range queries on createdAt pick this order up.
    // Native driver required — timestamps mark createdAt immutable, so a
    // Mongoose updateOne silently drops the backdate (see fixBackfillDates.js).
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { createdAt: when, updatedAt: when } }
    );
    console.log(`  inserted donationId=${donationId} _id=${order._id}`);
    inserted++;
  }

  console.log(`\nDone. inserted=${inserted} skipped=${skipped}` + (DRY_RUN ? " (dry-run)" : ""));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
