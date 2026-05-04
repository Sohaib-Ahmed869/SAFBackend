/* eslint-disable no-console */
require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const Order = require("../models/order");
const User = require("../models/user");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const TARGET_DONATION_ID = "95955433";

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  console.log("Connected to MongoDB\n");

  const order = await Order.findOne({ donationId: TARGET_DONATION_ID });
  if (!order) {
    console.log(`No order found with donationId=${TARGET_DONATION_ID}`);
    process.exit(0);
  }

  const user = order.user
    ? await User.findById(order.user).select("email firstName lastName name")
    : null;

  console.log("=== ORDER ===");
  console.log("donationId:", order.donationId);
  console.log("paymentType:", order.paymentType);
  console.log("paymentStatus:", order.paymentStatus);
  console.log("createdAt:", order.createdAt.toISOString());
  console.log("recurringDetails.amount:", order.recurringDetails?.amount);
  console.log("recurringDetails.frequency:", order.recurringDetails?.frequency);
  console.log("recurringDetails.endDate:", order.recurringDetails?.endDate?.toISOString());
  console.log("recurringDetails.startDate:", order.recurringDetails?.startDate?.toISOString());
  console.log("paymentHistory.length:", (order.recurringDetails?.paymentHistory || []).length);

  console.log("\n=== USER ===");
  if (!user) {
    console.log("(could not load user)");
    process.exit(0);
  }
  console.log("email:", user.email);
  console.log("name:", user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim());

  console.log(`\n=== Searching Stripe for customers with email=${user.email} ===`);
  const customers = await stripe.customers.list({ email: user.email, limit: 100 });
  console.log(`Found ${customers.data.length} Stripe customer(s)`);

  if (!customers.data.length) {
    console.log("[!] No Stripe customer found by email — this order may have been charged on a different Stripe account or in test mode.");
    console.log(`    Active STRIPE key prefix: ${(process.env.STRIPE_SECRET_KEY || "").slice(0, 12)}...`);
    process.exit(0);
  }

  const targetAmount = order.recurringDetails?.amount;
  const dbFreq = order.recurringDetails?.frequency;
  // DB stores "daily/weekly/monthly/yearly", Stripe stores "day/week/month/year".
  const freqMap = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
  const targetInterval = freqMap[dbFreq] || dbFreq;
  console.log(
    `\nMatching criteria: amount=$${targetAmount} interval=${targetInterval} (DB freq=${dbFreq})`
  );

  const matches = [];

  for (const customer of customers.data) {
    console.log(
      `\n--- Customer ${customer.id} (created ${new Date(customer.created * 1000).toISOString()}) ---`
    );
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 100,
    });
    console.log(`  Subscriptions: ${subs.data.length}`);
    for (const sub of subs.data) {
      const createdAt = new Date(sub.created * 1000);
      const items = sub.items?.data || [];
      const subAmount = items.reduce((sum, item) => {
        const unit = (item.price?.unit_amount || 0) / 100;
        const qty = item.quantity || 1;
        return sum + unit * qty;
      }, 0);
      const subInterval = items[0]?.price?.recurring?.interval || "?";

      const amountMatch = subAmount === targetAmount;
      const intervalMatch = subInterval === targetInterval;
      const flag = amountMatch && intervalMatch ? "★" : " ";
      console.log(
        `  ${flag} ${sub.id} status=${sub.status} created=${createdAt.toISOString()} amount=$${subAmount} interval=${subInterval}`
      );

      if (amountMatch && intervalMatch) {
        matches.push({ customer, subscription: sub });
      }
    }
  }

  if (!matches.length) {
    console.log(
      `\n[!] No subscription found matching amount=$${targetAmount} interval=${targetInterval}.`
    );
    console.log(
      "    The Stripe charges referenced in the user's report may not actually exist for this user/account."
    );
    process.exit(0);
  }

  console.log(`\n=== ${matches.length} candidate sub(s) match amount+frequency ===`);

  for (const m of matches) {
    console.log(`\n--- Candidate: ${m.subscription.id} (customer ${m.customer.id}) ---`);
    const invoices = await stripe.invoices.list({
      subscription: m.subscription.id,
      status: "paid",
      limit: 100,
    });
    let total = 0;
    console.log(`  Paid invoices: ${invoices.data.length}`);
    for (const inv of invoices.data) {
      const paidAt = inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
        : "(no paid_at)";
      const amt = (inv.amount_paid || 0) / 100;
      total += amt;
      console.log(`    ${inv.id} $${amt} paid_at=${paidAt}`);
    }
    console.log(`  TOTAL: $${total.toFixed(2)}`);
    m.totalPaid = total;
    m.invoices = invoices.data;
  }

  // Pick the candidate with the most paid invoices (most likely the real one).
  matches.sort((a, b) => (b.invoices?.length || 0) - (a.invoices?.length || 0));
  const best = matches[0];
  const invoices = { data: best.invoices };
  const total = best.totalPaid;

  console.log(`\n=== Best candidate (most invoices): ===`);
  console.log("customer:", best.customer.id);
  console.log("subscription:", best.subscription.id);
  console.log(`Total paid: $${total.toFixed(2)} across ${invoices.data.length} invoice(s)`);

  console.log("\n----------------------------------------------------");
  console.log("If the match looks correct and the total matches what you expect,");
  console.log("re-run with --apply to backfill the order:");
  console.log(`  node scripts/diagnose-recurring-95955433.js --apply`);
  console.log("----------------------------------------------------");

  if (process.argv.includes("--apply")) {
    console.log("\n*** APPLYING BACKFILL ***");
    order.transactionDetails = {
      ...(order.transactionDetails || {}),
      stripeCustomerId: best.customer.id,
      stripeSubscriptionId: best.subscription.id,
    };
    const newHistory = invoices.data
      .filter((inv) => inv.status_transitions?.paid_at)
      .map((inv) => ({
        date: new Date(inv.status_transitions.paid_at * 1000),
        amount: (inv.amount_paid || 0) / 100,
        invoiceId: inv.id,
        status: "succeeded",
      }));
    order.recurringDetails.paymentHistory = newHistory;
    order.recurringDetails.totalPayments = newHistory.length;
    if (newHistory.length) {
      const latest = newHistory.reduce((a, b) => (a.date > b.date ? a : b));
      order.lastPaymentDate = latest.date;
    }
    await order.save();
    console.log(`Backfilled ${newHistory.length} payment(s) onto order ${order.donationId}.`);
    console.log(`Total: $${total.toFixed(2)}`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
