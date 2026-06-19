/**
 * RECONCILE: sweep every PayPal recurring order already in the database and make
 * sure its payment history matches PayPal. For each order it fetches the
 * subscription's transactions from PayPal and:
 *   - appends any completed charge whose invoiceId is not already recorded,
 *   - corrects the frequency label if it disagrees with the plan's real interval.
 *
 * Append-only and idempotent: nothing is ever deleted or overwritten, and a
 * second run reports "0 to add". Always dry-run first.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/reconcilePaypalRecurring.js --dry-run
 *   node scripts/reconcilePaypalRecurring.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const axios = require("axios");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");
const {
  fetchPlanFrequency,
  fetchSubscription,
} = require("../controllers/paypalController");

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || "https://api-m.paypal.com";

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

async function getAccessToken() {
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const res = await axios.post(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data.access_token;
}

async function fetchSubscriptionTransactions(token, subscriptionId, startTime) {
  const all = [];
  const now = new Date();
  let windowStart = new Date(startTime);
  while (windowStart < now) {
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 30);
    const end = windowEnd < now ? windowEnd : now;
    try {
      const res = await axios.get(
        `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}/transactions`,
        {
          params: {
            start_time: windowStart.toISOString(),
            end_time: end.toISOString(),
          },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (Array.isArray(res.data.transactions)) all.push(...res.data.transactions);
    } catch (err) {
      console.error(
        `  ! transactions fetch failed for ${subscriptionId}:`,
        err.response?.data || err.message
      );
    }
    windowStart = windowEnd;
  }
  return all;
}

function getSubscriptionId(order) {
  const candidate =
    order.recurringDetails?.paypalSubscriptionId ||
    order.paypalDetails?.subscriptionId ||
    // Legacy orders stored the subscription id (I-...) under paypalDetails.paymentId.
    order.paypalDetails?.paymentId ||
    order.transactionDetails?.subscription_id ||
    order.externalId ||
    null;
  // Only trust PayPal subscription ids (I-...). transactionDetails on some orders
  // holds Stripe ids, which must not be queried against the PayPal API.
  if (typeof candidate === "string" && candidate.startsWith("I-")) return candidate;
  return null;
}

async function reconcileOrder(token, order) {
  const subscriptionId = getSubscriptionId(order);
  if (!subscriptionId || !order.recurringDetails) {
    console.log(`- ${order.donationId}: no subscription id / recurringDetails, skipping`);
    return { added: 0, freqFixed: false };
  }
  if (!Array.isArray(order.recurringDetails.paymentHistory)) {
    order.recurringDetails.paymentHistory = [];
  }

  // Use the subscription's true start_time so the window can't miss the first
  // charge (an order's createdAt can be a second or two AFTER charge #1).
  let startTime =
    order.recurringDetails.startDate || order.createdAt || new Date("2026-01-01");
  try {
    const sub = await fetchSubscription(subscriptionId);
    if (sub?.start_time) startTime = new Date(sub.start_time);
  } catch (err) {
    console.error(`  ! could not fetch subscription ${subscriptionId}, using order date:`, err.response?.data || err.message);
  }
  const txns = await fetchSubscriptionTransactions(token, subscriptionId, startTime);
  const completed = txns.filter((t) => t.status === "COMPLETED");

  const have = new Set(
    order.recurringDetails.paymentHistory.map((p) => p.invoiceId).filter(Boolean)
  );

  let added = 0;
  for (const t of completed) {
    if (have.has(t.id)) continue;
    const gross = t.amount_with_breakdown?.gross_amount?.value;
    order.recurringDetails.paymentHistory.push({
      date: t.time ? new Date(t.time) : new Date(),
      amount: gross != null ? parseFloat(gross) : order.recurringDetails.amount || 0,
      invoiceId: t.id,
      status: "succeeded",
    });
    have.add(t.id);
    added++;
  }

  // Correct a wrong frequency label (e.g. "monthly" on a daily plan).
  let freqFixed = false;
  const planId = order.recurringDetails.paypalPlanId || order.transactionDetails?.plan_id;
  const realFreq = await fetchPlanFrequency(planId);
  if (realFreq && order.recurringDetails.frequency !== realFreq) {
    console.log(
      `  frequency: "${order.recurringDetails.frequency}" -> "${realFreq}"`
    );
    order.recurringDetails.frequency = realFreq;
    freqFixed = true;
  }

  if ((added > 0 || freqFixed)) {
    if (added > 0) {
      order.recurringDetails.paymentHistory.sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );
      order.recurringDetails.totalPayments =
        order.recurringDetails.paymentHistory.length;
      order.recurringDetails.lastPaymentDate =
        order.recurringDetails.paymentHistory[
          order.recurringDetails.paymentHistory.length - 1
        ]?.date;
    }
    if (!DRY_RUN) {
      order.markModified("recurringDetails");
      await order.save();
    }
  }

  console.log(
    `- ${order.donationId} (${subscriptionId}): ${completed.length} at PayPal, ` +
      `${order.recurringDetails.paymentHistory.length} in DB, ${added} added` +
      (DRY_RUN ? " [dry-run]" : "")
  );
  return { added, freqFixed };
}

async function main() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in env.");
    process.exit(1);
  }

  await connectDB();
  const token = await getAccessToken();

  const orders = await Order.find({
    paymentType: "recurring",
    paymentMethod: "paypal",
  });
  console.log(
    `Reconciling ${orders.length} PayPal recurring order(s)` +
      (DRY_RUN ? " [DRY RUN — no writes]" : "") +
      "\n"
  );

  let totalAdded = 0;
  let freqFixes = 0;
  for (const order of orders) {
    const { added, freqFixed } = await reconcileOrder(token, order);
    totalAdded += added;
    if (freqFixed) freqFixes++;
  }

  console.log(
    `\nDone. ${DRY_RUN ? "Would add" : "Added"} ${totalAdded} payment(s); ` +
      `${freqFixes} frequency label(s) ${DRY_RUN ? "would be" : ""} corrected.`
  );
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Reconcile failed:", err.response?.data || err.message || err);
  process.exit(1);
});
