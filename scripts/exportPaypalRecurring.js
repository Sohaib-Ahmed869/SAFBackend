/**
 * EXPORT-ONLY: build the missing PayPal recurring orders + payment history into a
 * JSON file for review. This script NEVER connects to or writes to the database.
 * It only READS from PayPal (GET subscription + GET transactions).
 *
 * Review the resulting JSON, then run importPaypalRecurring.js to commit it.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/exportPaypalRecurring.js I-XXXXXXXX [I-YYYYYYYY ...]
 *
 * Output: scripts/backfill-output/paypal-backfill-<timestamp>.json
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// buildRecurringOrderData is pure (no DB) and gives the exact order shape the
// live webhook would create.
const {
  buildRecurringOrderData,
  fetchPlanFrequency,
} = require("../controllers/paypalController");

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || "https://api-m.paypal.com";

const subscriptionIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));

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

async function fetchSubscription(token, subscriptionId) {
  const res = await axios.get(
    `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

// PayPal limits the transactions window; page through it in <=30-day chunks.
async function fetchSubscriptionTransactions(token, subscriptionId, startTime) {
  const all = [];
  const now = new Date();
  let windowStart = new Date(startTime);

  while (windowStart < now) {
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 30);
    const end = windowEnd < now ? windowEnd : now;

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
    windowStart = windowEnd;
  }
  return all;
}

async function main() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in env.");
    process.exit(1);
  }
  if (subscriptionIds.length === 0) {
    console.error("Pass at least one subscription id, e.g.: node scripts/exportPaypalRecurring.js I-XXXX");
    process.exit(1);
  }

  const token = await getAccessToken();
  const out = { generatedAt: new Date().toISOString(), subscriptions: [] };

  for (const subId of subscriptionIds) {
    console.log(`\n=== ${subId} ===`);
    const sub = await fetchSubscription(token, subId);
    console.log(`status: ${sub.status}, plan: ${sub.plan_id}`);

    const startTime = sub.start_time || sub.create_time || "2026-01-01T00:00:00Z";
    const txns = await fetchSubscriptionTransactions(token, subId, startTime);
    const completed = txns.filter((t) => t.status === "COMPLETED");
    console.log(`transactions: ${txns.length} total, ${completed.length} completed`);

    // Resolve true frequency (daily/weekly/...) from the plan's billing interval.
    const frequency = await fetchPlanFrequency(sub.plan_id);
    console.log(`frequency: ${frequency || "(unknown, will fall back)"}`);

    // Canonical order shape (empty history), then fill history from transactions.
    const order = buildRecurringOrderData(sub, subId /* no logged-in user */, undefined, frequency);
    order.recurringDetails.paymentHistory = completed
      .map((t) => ({
        date: t.time ? new Date(t.time).toISOString() : new Date().toISOString(),
        amount:
          t.amount_with_breakdown?.gross_amount?.value != null
            ? parseFloat(t.amount_with_breakdown.gross_amount.value)
            : order.recurringDetails.amount || 0,
        invoiceId: t.id,
        status: "succeeded",
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    order.recurringDetails.totalPayments =
      order.recurringDetails.paymentHistory.length;
    order.recurringDetails.lastPaymentDate =
      order.recurringDetails.paymentHistory[
        order.recurringDetails.paymentHistory.length - 1
      ]?.date || null;

    const sum = order.recurringDetails.paymentHistory.reduce(
      (s, p) => s + (p.amount || 0),
      0
    );
    console.log(
      `donor: ${order.donorDetails.name} <${order.donorDetails.email}> | ` +
        `history entries: ${order.recurringDetails.paymentHistory.length} | total $${sum.toFixed(2)}`
    );

    out.subscriptions.push({
      subscriptionId: subId,
      paypalStatus: sub.status,
      completedCount: completed.length,
      order,
    });
  }

  const dir = path.join(__dirname, "backfill-output");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `paypal-backfill-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\nWrote ${out.subscriptions.length} subscription(s) to:\n  ${file}`);
  console.log("\nNo database was touched. Review the file, then run:");
  console.log(`  node scripts/importPaypalRecurring.js "${file}" --dry-run`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Export failed:", err.response?.data || err.message || err);
  process.exit(1);
});
