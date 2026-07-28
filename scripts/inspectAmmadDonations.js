/**
 * READ-ONLY: inspect donor record + existing orders for ammadmansoor@hotmail.com
 * ahead of the FY24-25 PayPal backfill. Writes nothing.
 *
 * Usage (from SAFBackend-1/): node scripts/inspectAmmadDonations.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Order = require("../models/order");
const User = require("../models/user");

const EMAIL = "ammadmansoor@hotmail.com";

// The 8 PayPal transaction IDs from the donor's PayPal activity export (FY24-25)
const PAYPAL_TXN_IDS = [
  "5E69051890119704E",
  "3SR51322K99789303",
  "9RX46991C17634339",
  "0EE43532US522631D",
  "4XY184336W407632V",
  "1DW2923952514354E",
  "87877334LJ6756328",
  "2DM404134H657511V",
];

async function main() {
  await connectDB();

  const user = await User.findOne({ email: EMAIL }).lean();
  if (!user) {
    console.log(`NO user found with email ${EMAIL}`);
  } else {
    console.log("USER FOUND:");
    console.log(
      JSON.stringify(
        {
          _id: user._id,
          name: user.name,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          address: user.address,
          role: user.role,
          createdAt: user.createdAt,
        },
        null,
        2
      )
    );
  }

  const query = user
    ? { $or: [{ user: user._id }, { "donorDetails.email": EMAIL }] }
    : { "donorDetails.email": EMAIL };

  const orders = await Order.find(query).sort({ createdAt: 1 }).lean();
  console.log(`\nEXISTING ORDERS (${orders.length}):`);
  for (const o of orders) {
    console.log(
      JSON.stringify(
        {
          _id: o._id,
          donationId: o.donationId,
          user: o.user,
          createdAt: o.createdAt,
          paymentType: o.paymentType,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          totalAmount: o.totalAmount,
          donationType: o.donationType,
          items: (o.items || []).map((i) => ({
            title: i.title,
            price: i.price,
            quantity: i.quantity,
            donationType: i.donationType,
          })),
          donorEmail: o.donorDetails?.email,
          paypalDetails: o.paypalDetails,
          transactionDetails: o.transactionDetails,
          recurringPayments: o.recurringDetails?.paymentHistory?.length,
          installmentsPaid: o.installmentDetails?.installmentsPaid,
        },
        null,
        2
      )
    );
  }

  // Any order anywhere in the DB already referencing one of the 8 txn ids?
  console.log("\nTXN ID MATCHES ANYWHERE IN ORDERS:");
  for (const txn of PAYPAL_TXN_IDS) {
    const hit = await Order.findOne({
      $or: [
        { "paypalDetails.paymentId": txn },
        { "paypalDetails.lastPaymentId": txn },
        { "transactionDetails.paypal_transaction_id": txn },
        { "transactionDetails.transaction_id": txn },
        { "transactionDetails.id": txn },
        { externalId: txn },
        { "recurringDetails.paymentHistory.invoiceId": txn },
      ],
    })
      .select("_id donationId createdAt totalAmount")
      .lean();
    console.log(`  ${txn}: ${hit ? JSON.stringify(hit) : "not found"}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
