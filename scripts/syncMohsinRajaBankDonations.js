/**
 * One-off: replay Mohsin Raja's FY 2025-26 bank-transfer template rows through
 * the real donation-sync pipeline (parseUploadedFile -> previewForUser ->
 * commitForUser). The original admin upload only inserted 3 of 14 rows because
 * the duplicate check treated the repeated bank statement description
 * ("DEPOSIT MOHSIN RAJA Educate 4 children") as a unique transaction ID —
 * fixed in services/paypalDonationSync.js, but the production backend hasn't
 * been redeployed, so this inserts the missing rows using the fixed local code.
 *
 * Usage (from SAFBackend-1/):
 *   node scripts/syncMohsinRajaBankDonations.js           # preview only
 *   node scripts/syncMohsinRajaBankDonations.js --apply   # commit
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/user");
const {
  parseUploadedFile,
  previewForUser,
  commitForUser,
} = require("../services/paypalDonationSync");

const APPLY = process.argv.includes("--apply");
const USER_ID = "6a77e3ba844ef27341258a65";

const HEADER = [
  "Payment Method (bank or paypal)",
  "Date (DD/MM/YYYY)",
  "Time (HH:MM, optional)",
  "Amount (AUD)",
  "Fee (AUD, optional)",
  "Transaction ID / Reference (optional)",
  "Donor Email (optional)",
  "Donor Name (optional)",
  "Cause (optional)",
  "Notes (optional)",
];

// (date, amount, reference) — exactly as filled out on the SAF template.
const ROWS = [
  ["25/07/25", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["25/08/25", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["25/09/25", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["27/10/25", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["25/11/25", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["29/12/25", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["27/01/26", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  [
    "02/02/26",
    "600.00",
    "DEPOSIT-OSKO PAYMENT 2042502 MOHSIN RAJA Large Hand Pump - Mohsin Raja Large Hand Pump - Mohsin Raja 31 JAN 2026",
  ],
  ["25/02/26", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["25/03/26", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["27/04/26", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  ["25/05/26", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
  [
    "27/05/26",
    "115.90",
    "DEPOSIT-OSKO PAYMENT 2669401 SYED FAHEEM sadaqa mohsin raja sadaqa mohsin raja",
  ],
  ["25/06/26", "100.00", "DEPOSIT MOHSIN RAJA Educate 4 children"],
];

const buildCsv = () => {
  const lines = [HEADER.map((h) => `"${h}"`).join(",")];
  for (const [date, amount, ref] of ROWS) {
    lines.push(
      [
        "bank",
        date,
        "",
        amount,
        "",
        `"${ref}"`,
        "mohsinraja82@yahoo.com",
        "Mohsin Raja",
        "Education",
        "Direct deposit shown on bank statement",
      ].join(",")
    );
  }
  return Buffer.from(lines.join("\n"), "utf8");
};

async function main() {
  await connectDB();

  const user = await User.findById(USER_ID);
  if (!user) throw new Error(`User ${USER_ID} not found`);
  console.log(`Donor: ${user.name} <${user.email}>\n`);

  const { format, transactions, ignored } = parseUploadedFile(buildCsv());
  console.log(`Parsed as ${format}: ${transactions.length} transaction(s), ${ignored.length} ignored`);
  for (const ig of ignored) console.log(`  ignored row ${ig.row}: ${ig.reason}`);

  const preview = await previewForUser(user, transactions);
  console.log("\nPreview:");
  for (const row of preview) {
    console.log(
      `  ${row.date.slice(0, 10)} $${row.gross} -> ${row.action} (${row.reason})`
    );
  }

  if (!APPLY) {
    console.log("\nPreview only. Re-run with --apply to commit.");
  } else {
    const results = await commitForUser(user, transactions);
    console.log("\nCommit results:");
    for (const r of results) {
      console.log(
        `  ${r.status}${r.donationId ? ` (${r.donationId})` : ""}${r.reason ? ` — ${r.reason}` : ""}`
      );
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
