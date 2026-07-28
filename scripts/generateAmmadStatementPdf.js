/**
 * Generate the FY 2024-2025 donation statement PDF for ammadmansoor@hotmail.com
 * by invoking the SAME controller the website endpoint uses
 * (GET /api/orders/statement/pdf?financialYear=2024-2025), with a stubbed
 * req/res. Output: scripts/output/donation_statement_ammad_fy_2024_2025.pdf
 *
 * Usage (from SAFBackend-1/): node scripts/generateAmmadStatementPdf.js
 */

require("dotenv").config({ override: true });

const dns = require("dns");
dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/user");
const orderController = require("../controllers/orderContrller");

async function main() {
  await connectDB();

  const user = await User.findOne({ email: "ammadmansoor@hotmail.com" });
  if (!user) throw new Error("Donor user not found");

  const req = { user, query: { financialYear: "2024-2025" } };

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "donation_statement_ammad_fy_2024_2025.pdf");

  let statusCode = 200;
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      console.error(`Controller responded ${statusCode}:`, JSON.stringify(body));
      return this;
    },
    send(buffer) {
      fs.writeFileSync(outFile, buffer);
      console.log(`PDF written (${buffer.length} bytes): ${outFile}`);
      return this;
    },
  };

  await orderController.generateStatementPDF(req, res);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
