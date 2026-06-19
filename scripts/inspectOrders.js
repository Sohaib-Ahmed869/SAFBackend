/**
 * READ-ONLY: dump key fields of PayPal recurring orders that have no
 * recurringDetails / subscription id, to understand what they are.
 * Makes no writes.
 */
require("dotenv").config({ override: true });
const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");

async function main() {
  await connectDB();
  const orders = await Order.find({
    paymentType: "recurring",
    paymentMethod: "paypal",
  }).lean();

  for (const o of orders) {
    const subId =
      o.recurringDetails?.paypalSubscriptionId ||
      o.transactionDetails?.subscription_id ||
      o.externalId ||
      null;
    console.log("─".repeat(60));
    console.log("donationId   :", o.donationId);
    console.log("_id          :", String(o._id));
    console.log("createdAt    :", o.createdAt);
    console.log("paymentStatus:", o.paymentStatus);
    console.log("totalAmount  :", o.totalAmount);
    console.log("subscriptionId:", subId);
    console.log("externalId   :", o.externalId);
    console.log("hasRecurringDetails:", !!o.recurringDetails);
    console.log("donor        :", o.donorDetails?.name, "<" + (o.donorDetails?.email || "") + ">");
    console.log("user         :", o.user ? String(o.user) : null);
    console.log("items        :", JSON.stringify(o.items));
    console.log("transactionDetails keys:", o.transactionDetails ? Object.keys(o.transactionDetails) : null);
    console.log("paypalDetails:", o.paypalDetails ? JSON.stringify(o.paypalDetails) : null);
    console.log("details.id   :", o.details?.id || null);
  }
  console.log("─".repeat(60));
  console.log(`Total: ${orders.length} paypal recurring orders`);
  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
