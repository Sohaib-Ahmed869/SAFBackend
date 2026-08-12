/**
 * Donation sync engine (PayPal + bank transfers).
 *
 * Recovers donations that never made it into Mongo (failed PayPal webhooks,
 * direct bank deposits) so a donor's annual statement is complete. Sources:
 *
 *  - an uploaded PayPal activity export (.xlsx / .csv, the file donors or
 *    finance download from PayPal), parsed with SheetJS,
 *  - an uploaded SAF donation template (.xlsx / .csv) — the fill-out sheet
 *    admins download from the same screen; carries a "Payment Method" column
 *    so one parser covers both bank and PayPal manual entries,
 *  - the PayPal Transaction Search API (/v1/reporting/transactions),
 *    filtered to the donor's email(s).
 *
 * All sources normalise into the same transaction shape, which is then
 * annotated against the DB (previewForUser) and, once the admin confirms,
 * written (commitForUser). Commit re-runs every duplicate check, so a stale
 * preview can never double-insert — same idempotency rules as
 * scripts/backfillAmmadPaypalFY2425.js, which this generalises.
 */

const axios = require("axios");
const XLSX = require("xlsx");
const Order = require("../models/order");

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || "https://api-m.paypal.com";

// ---------------------------------------------------------------------------
// Normalised transaction shape (JSON-safe so the preview can round-trip
// through the admin UI back into commit):
// { txnId, date (ISO UTC), gross, fee, net, currency, payerEmail, payerName,
//   title, type, subscriptionId, address, source }
// ---------------------------------------------------------------------------

const getAccessToken = async () => {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await axios.post(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return response.data.access_token;
};

// --------------------------- file export parsing ---------------------------

// PayPal export column names vary slightly between the xlsx and csv variants
// ("From email" vs "From Email Address"); look keys up loosely.
const pick = (row, names) => {
  for (const name of names) {
    const key = Object.keys(row).find(
      (k) => k.trim().toLowerCase() === name.toLowerCase()
    );
    if (key !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
};

// Template headers carry hints like "Date (DD/MM/YYYY)" and admins may trim
// them — match on the start of the header instead of the full text.
const pickFuzzy = (row, bases) => {
  for (const base of bases) {
    const key = Object.keys(row).find((k) =>
      k.trim().toLowerCase().startsWith(base.toLowerCase())
    );
    if (key !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
};

const TZ_OFFSET_HOURS = {
  AEST: 10,
  AEDT: 11,
  ACST: 9.5,
  ACDT: 10.5,
  AWST: 8,
  UTC: 0,
  GMT: 0,
  PST: -8,
  PDT: -7,
};

const parseMoney = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

const parseTimeParts = (timeStr) => {
  const tm = String(timeStr || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!tm) return null;
  return { hh: Number(tm[1]), mm: Number(tm[2]), ss: Number(tm[3] || 0) };
};

// "2024-08-08" — how date cells come out when the workbook is read with
// cellDates + dateNF (see parseUploadedFile). Unambiguous, try it first.
const parseIsoDateParts = (dateStr) => {
  const m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};

const buildLocalDate = ({ year, month, day }, time, offsetHours) => {
  const { hh, mm, ss } = time || { hh: 0, mm: 0, ss: 0 };
  return new Date(Date.UTC(year, month - 1, day, hh, mm, ss) - offsetHours * 3600 * 1000);
};

// PayPal exports use M/D/YY (US order — confirmed by rows like 12/19/24).
// If the first number can't be a month, fall back to D/M/YY.
const parseExportDate = (dateStr, timeStr, tzStr) => {
  if (!dateStr) return null;
  const offset = TZ_OFFSET_HOURS[String(tzStr || "").trim().toUpperCase()] ?? 10;
  const time = parseTimeParts(timeStr);

  const iso = parseIsoDateParts(dateStr);
  if (iso) return buildLocalDate(iso, time, offset);

  const dm = String(dateStr).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!dm) return null;
  let [, first, second, year] = dm.map(Number);
  let month = first;
  let day = second;
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (year < 100) year += 2000;
  return buildLocalDate({ year, month, day }, time, offset);
};

// SAF template dates are hand-typed by Australian admins: DD/MM/YYYY
// (day first — the opposite of PayPal's export). ISO also accepted. When no
// time is given, noon AEST keeps the donation inside the right calendar day
// and financial year regardless of timezone rounding.
const parseTemplateDate = (dateStr, timeStr) => {
  if (!dateStr) return null;
  const time = parseTimeParts(timeStr) || { hh: 12, mm: 0, ss: 0 };

  const iso = parseIsoDateParts(dateStr);
  if (iso) return buildLocalDate(iso, time, 10);

  const dm = String(dateStr).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!dm) return null;
  let [, first, second, year] = dm.map(Number);
  let day = first;
  let month = second;
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (month > 12 || day > 31) return null;
  if (year < 100) year += 2000;
  return buildLocalDate({ year, month, day }, time, 10);
};

// Row types that are never donations (fees, transfers, conversions, refunds).
const EXCLUDED_TYPE_PATTERNS =
  /(conversion|withdrawal|transfer|refund|reversal|hold|release|fee|chargeback|dispute)/i;

const cleanTitle = (raw) => {
  if (!raw) return null;
  // Keep the first line and strip price suffixes:
  // "Educate a Child - AUD 300" / "Sadaqa - any amount" -> the cause name.
  const firstLine = String(raw).split(/\r?\n/)[0];
  return firstLine.replace(/\s*-\s*(any amount|[A-Z]{3}\s*[\d.,]+)\s*$/i, "").trim() || null;
};

// A usable cause name has letters in it — guards against exports where
// "Item ID" is a numeric SKU rather than the donation button name.
const titleIfNamed = (raw) => {
  const cleaned = cleanTitle(raw);
  return cleaned && /[a-z]/i.test(cleaned) ? cleaned : null;
};

/**
 * Parse the rows of a PayPal activity export into normalised transactions.
 * Returns { transactions, ignored } where ignored explains every row that was
 * not treated as a donation.
 */
const parsePaypalExportRows = (rows) => {
  const transactions = [];
  const ignored = [];

  rows.forEach((row, i) => {
    const rowNo = i + 2; // 1-based + header row
    const txnId = pick(row, ["Transaction ID"]);
    const type = pick(row, ["Type"]) || "";
    const status = pick(row, ["Status"]) || "";
    const gross = parseMoney(pick(row, ["Gross"]));
    const balanceImpact = pick(row, ["Balance Impact"]);

    const skip = (reason) => ignored.push({ row: rowNo, txnId, type, reason });

    if (!txnId) return skip("no transaction ID");
    if (!/^completed$/i.test(status.trim())) return skip(`status is "${status}"`);
    if (EXCLUDED_TYPE_PATTERNS.test(type)) return skip(`type "${type}" is not a donation`);
    if (balanceImpact && !/^credit$/i.test(String(balanceImpact).trim()))
      return skip(`balance impact is "${balanceImpact}" (money out, not a donation)`);
    if (!gross || gross <= 0) return skip("gross amount is zero or negative");

    const date = parseExportDate(
      pick(row, ["Date"]),
      pick(row, ["Time"]),
      pick(row, ["Time zone", "TimeZone", "Time Zone"])
    );
    if (!date) return skip("could not parse date");

    const referenceTxn = pick(row, ["Reference Txn ID", "Reference Transaction ID"]);
    const subscriptionId =
      referenceTxn && /^I-/i.test(String(referenceTxn).trim())
        ? String(referenceTxn).trim()
        : null;

    const street = pick(row, ["Address line 1", "Address Line 1"]);
    const city = pick(row, ["Suburb", "Town/City", "City"]);
    const state = pick(row, [
      "State/Territory/Province/Region/County/Prefecture/Republic",
      "State/Province/Region/County/Territory/Prefecture/Republic",
      "State",
    ]);
    const postcode = pick(row, ["Postcode", "Zip/Postal Code", "Postal Code"]);

    transactions.push({
      txnId: String(txnId).trim(),
      date: date.toISOString(),
      gross,
      fee: Math.abs(parseMoney(pick(row, ["Fee"])) || 0),
      net: parseMoney(pick(row, ["Net"])),
      currency: pick(row, ["Currency"]) || "AUD",
      payerEmail: String(pick(row, ["From email", "From Email Address"]) || "")
        .trim()
        .toLowerCase(),
      payerName: pick(row, ["Name"]) || null,
      // In SAF's exports the donation-button name ("Educate a Child - AUD 300")
      // is in "Item ID"; "Item Title" carries the long page description.
      title:
        titleIfNamed(pick(row, ["Item ID"])) ||
        titleIfNamed(pick(row, ["Item Title"])) ||
        titleIfNamed(pick(row, ["Note"])) ||
        "PayPal Donation",
      type,
      subscriptionId,
      address: street || city || state || postcode
        ? { street, city, state, postcode }
        : null,
      paymentMethod: "paypal",
      source: "file",
    });
  });

  return { transactions, ignored };
};

/**
 * Parse rows of the SAF donation template (downloaded from the admin screen
 * and filled out by hand). The "Payment Method" column decides whether each
 * row becomes a bank or PayPal donation.
 */
const parseSafTemplateRows = (rows) => {
  const transactions = [];
  const ignored = [];

  rows.forEach((row, i) => {
    const rowNo = i + 2; // 1-based + header row
    const skip = (reason) => ignored.push({ row: rowNo, reason });

    const methodRaw = String(pickFuzzy(row, ["Payment Method"]) || "").trim().toLowerCase();
    const method = /paypal/.test(methodRaw)
      ? "paypal"
      : /bank|eft|transfer|deposit/.test(methodRaw)
        ? "bank"
        : null;
    if (!method)
      return skip(
        methodRaw
          ? `unrecognised payment method "${methodRaw}" (use "bank" or "paypal")`
          : "payment method is empty (use \"bank\" or \"paypal\")"
      );

    const gross = parseMoney(pickFuzzy(row, ["Amount"]));
    if (!gross || gross <= 0) return skip("amount is missing or not positive");

    const date = parseTemplateDate(pickFuzzy(row, ["Date"]), pickFuzzy(row, ["Time"]));
    if (!date) return skip("could not read the date (use DD/MM/YYYY)");

    const txnId = pickFuzzy(row, ["Transaction ID", "Reference"]);
    const fee = Math.abs(parseMoney(pickFuzzy(row, ["Fee"])) || 0);

    transactions.push({
      txnId: txnId ? String(txnId).trim() : null,
      date: date.toISOString(),
      gross,
      fee,
      net: Math.round((gross - fee) * 100) / 100,
      currency: "AUD",
      payerEmail: String(pickFuzzy(row, ["Donor Email", "Email"]) || "")
        .trim()
        .toLowerCase(),
      payerName: pickFuzzy(row, ["Donor Name"]) || null,
      title:
        pickFuzzy(row, ["Cause"]) ||
        (method === "bank" ? "Bank Transfer Donation" : "PayPal Donation"),
      type: "Manual entry",
      subscriptionId: null,
      address: null,
      notes: pickFuzzy(row, ["Notes"]) || null,
      paymentMethod: method,
      source: "template",
    });
  });

  return { transactions, ignored };
};

/**
 * Parse any supported upload (.xlsx/.xls/.csv buffer): a PayPal activity
 * export or the SAF donation template — detected by header row. Returns
 * { format, transactions, ignored }.
 */
const parseUploadedFile = (buffer) => {
  // cellDates + dateNF renders real date cells as unambiguous ISO strings
  // (hand-typed text like "8/8/24" or "15/03/2025" comes through untouched
  // and is handled by the format-specific date parsers).
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    raw: false,
    defval: null,
    dateNF: "yyyy-mm-dd",
  });
  if (rows.length === 0) {
    throw new Error("The file has no data rows below the header.");
  }

  const headers = Object.keys(rows[0]).map((h) => h.trim().toLowerCase());
  if (headers.some((h) => h.startsWith("payment method"))) {
    return { format: "saf-template", ...parseSafTemplateRows(rows) };
  }
  if (headers.includes("gross") && headers.includes("status")) {
    return { format: "paypal-export", ...parsePaypalExportRows(rows) };
  }
  throw new Error(
    "Unrecognised file format. Upload a PayPal activity export, or download the SAF template from this screen, fill it out and upload it."
  );
};

// ------------------------ PayPal Transaction Search ------------------------

const MS_PER_DAY = 24 * 3600 * 1000;
// Transaction Search allows at most 31 days per request and 3 years back.
const CHUNK_DAYS = 31;
const MAX_LOOKBACK_MS = 3 * 365 * MS_PER_DAY;

/**
 * Pull the donor's completed PayPal payments between startDate and endDate
 * (Date objects) via the Transaction Search API, matching any of `emails`
 * (lower-cased). Returns { transactions, clampedStart } — clampedStart is set
 * when the range had to be trimmed to PayPal's 3-year window.
 */
const fetchPaypalTransactions = async ({ startDate, endDate, emails }) => {
  const emailSet = new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const accessToken = await getAccessToken();

  const now = new Date();
  let start = new Date(startDate);
  let end = endDate > now ? now : new Date(endDate);
  let clampedStart = null;
  const oldestAllowed = new Date(now.getTime() - MAX_LOOKBACK_MS + MS_PER_DAY);
  if (start < oldestAllowed) {
    clampedStart = oldestAllowed.toISOString();
    start = oldestAllowed;
  }

  const transactions = [];
  const seen = new Set();

  for (let winStart = start; winStart < end; ) {
    const winEnd = new Date(
      Math.min(winStart.getTime() + CHUNK_DAYS * MS_PER_DAY - 1000, end.getTime())
    );

    let page = 1;
    let totalPages = 1;
    do {
      const res = await axios.get(`${PAYPAL_BASE_URL}/v1/reporting/transactions`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          start_date: winStart.toISOString(),
          end_date: winEnd.toISOString(),
          transaction_status: "S",
          fields: "transaction_info,payer_info,cart_info",
          page_size: 500,
          page,
        },
      });

      totalPages = res.data.total_pages || 1;
      for (const t of res.data.transaction_details || []) {
        const info = t.transaction_info || {};
        const payerEmail = String(t.payer_info?.email_address || "").toLowerCase();
        if (!emailSet.has(payerEmail)) continue;

        const gross = parseFloat(info.transaction_amount?.value || 0);
        if (!Number.isFinite(gross) || gross <= 0) continue; // refunds are negative

        const txnId = info.transaction_id;
        if (!txnId || seen.has(txnId)) continue;
        seen.add(txnId);

        const fee = Math.abs(parseFloat(info.fee_amount?.value || 0)) || 0;
        const payerName = t.payer_info?.payer_name?.alternate_full_name ||
          [t.payer_info?.payer_name?.given_name, t.payer_info?.payer_name?.surname]
            .filter(Boolean)
            .join(" ") || null;

        transactions.push({
          txnId,
          date: new Date(info.transaction_initiation_date).toISOString(),
          gross,
          fee,
          net: Math.round((gross - fee) * 100) / 100,
          currency: info.transaction_amount?.currency_code || "AUD",
          payerEmail,
          payerName,
          // item_code carries the donation-button name ("Educate a Child -
          // AUD 300"); item_name is the long page description.
          title:
            titleIfNamed(t.cart_info?.item_details?.[0]?.item_code) ||
            titleIfNamed(t.cart_info?.item_details?.[0]?.item_name) ||
            info.transaction_subject ||
            "PayPal Donation",
          type: info.transaction_event_code || "PAYMENT",
          subscriptionId:
            info.paypal_reference_id_type === "SUB" && info.paypal_reference_id
              ? info.paypal_reference_id
              : null,
          address: null,
          paymentMethod: "paypal",
          source: "paypal",
        });
      }
      page += 1;
    } while (page <= totalPages);

    winStart = new Date(winEnd.getTime() + 1000);
  }

  transactions.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { transactions, clampedStart };
};

// ------------------------------ dedupe / apply -----------------------------

const generateDonationId = () =>
  `${Math.floor(1000 + Math.random() * 9000)}${Math.floor(1000 + Math.random() * 9000)}`;

const generateUniqueDonationId = async () => {
  for (let i = 0; i < 5; i++) {
    const id = generateDonationId();
    if (!(await Order.findOne({ donationId: id }))) return id;
  }
  throw new Error("Could not generate unique donationId");
};

// Every place a transaction id / bank reference could already live on an order.
const findOrderByTxnId = (txnId) =>
  Order.findOne({
    $or: [
      { "paypalDetails.paymentId": txnId },
      { "paypalDetails.lastPaymentId": txnId },
      { "transactionDetails.paypal_transaction_id": txnId },
      { "transactionDetails.bank_reference": txnId },
      { externalId: txnId },
      { "recurringDetails.paymentHistory.invoiceId": txnId },
    ],
  });

const findRecurringOrderBySubscriptionId = (subscriptionId) =>
  Order.findOne({
    $or: [
      { "recurringDetails.paypalSubscriptionId": subscriptionId },
      { "paypalDetails.subscriptionId": subscriptionId },
      { "paypalDetails.paymentId": subscriptionId },
      { "transactionDetails.subscription_id": subscriptionId },
      { externalId: subscriptionId },
    ],
  });

/**
 * Decide what committing this transaction for this user would do.
 * Returns { action: 'insert' | 'recurring' | 'skip', reason,
 *           existingDonationId?, recurringOrderId? }.
 */
const classifyTransaction = async (user, txn) => {
  // Bank/template rows may have no reference id — then only the
  // amount-within-a-day check below can catch duplicates.
  if (txn.txnId && txn.paymentMethod === "bank") {
    // Bank "references" are statement description lines and repeat across
    // months (e.g. "DEPOSIT <NAME> Educate 4 children" on every monthly
    // deposit), so a reference match alone is not proof of a duplicate —
    // the amount and date must line up too.
    const when = new Date(txn.date);
    const candidates = await Order.find({
      "transactionDetails.bank_reference": txn.txnId,
    }).select("donationId totalAmount createdAt lastPaymentDate");
    const dup = candidates.find((o) => {
      const orderWhen = new Date(o.lastPaymentDate || o.createdAt);
      return (
        Math.abs((o.totalAmount || 0) - txn.gross) < 0.005 &&
        Math.abs(orderWhen - when) <= MS_PER_DAY
      );
    });
    if (dup) {
      return {
        action: "skip",
        reason: "same reference, amount and date already recorded",
        existingDonationId: dup.donationId,
      };
    }
  } else if (txn.txnId) {
    const byTxn = await findOrderByTxnId(txn.txnId);
    if (byTxn) {
      return {
        action: "skip",
        reason: "transaction ID already recorded",
        existingDonationId: byTxn.donationId,
      };
    }
  }

  if (txn.subscriptionId) {
    const recurringOrder = await findRecurringOrderBySubscriptionId(txn.subscriptionId);
    if (recurringOrder) {
      const already = (recurringOrder.recurringDetails?.paymentHistory || []).some(
        (p) => p.invoiceId === txn.txnId
      );
      if (already) {
        return {
          action: "skip",
          reason: "payment already in recurring history",
          existingDonationId: recurringOrder.donationId,
        };
      }
      return {
        action: "recurring",
        reason: `will be added to recurring donation ${recurringOrder.donationId}`,
        existingDonationId: recurringOrder.donationId,
        recurringOrderId: recurringOrder._id.toString(),
      };
    }
    // Subscription order was never created (webhook missed it too) — record the
    // payment as a standalone order so it still shows on the statement.
  }

  // Same donor, same amount, within a day — guards against manually entered
  // copies that lack the PayPal transaction id.
  const when = new Date(txn.date).getTime();
  const dayStart = new Date(when - MS_PER_DAY);
  const dayEnd = new Date(when + MS_PER_DAY);
  const emails = [user.email, txn.payerEmail].filter(Boolean);
  const byAmountDate = await Order.findOne({
    $or: [{ user: user._id }, { "donorDetails.email": { $in: emails } }],
    $and: [
      {
        $or: [
          { totalAmount: txn.gross, createdAt: { $gte: dayStart, $lte: dayEnd } },
          {
            "recurringDetails.paymentHistory": {
              $elemMatch: { amount: txn.gross, date: { $gte: dayStart, $lte: dayEnd } },
            },
          },
        ],
      },
    ],
  });
  if (byAmountDate) {
    return {
      action: "skip",
      reason: "same amount within 1 day already recorded",
      existingDonationId: byAmountDate.donationId,
    };
  }

  return { action: "insert", reason: "missing from database" };
};

/**
 * Annotate normalised transactions with what commit would do — this is the
 * preview the admin confirms. Adds emailMatch so the UI can flag payments made
 * from a PayPal email that differs from the donor's account email.
 */
const previewForUser = async (user, transactions) => {
  const userEmail = String(user.email || "").toLowerCase();
  const rows = [];
  for (const txn of transactions) {
    const verdict = await classifyTransaction(user, txn);
    rows.push({
      ...txn,
      ...verdict,
      // Stable key for the UI's selection — template rows can lack a txnId.
      rowKey: txn.txnId || `row-${rows.length + 1}`,
      emailMatch: !txn.payerEmail || txn.payerEmail === userEmail,
    });
  }
  return rows;
};

const buildOneTimeOrder = (user, txn, donationId) => {
  const when = new Date(txn.date);
  const address = txn.address || user.address || {};
  const method = txn.paymentMethod === "bank" ? "bank" : "paypal";

  const transactionDetails =
    method === "paypal"
      ? {
          ...(txn.txnId ? { paypal_transaction_id: txn.txnId } : {}),
          paypal_gross: txn.gross,
          ...(txn.fee ? { paypal_fee: txn.fee, paypal_net: txn.net } : {}),
          currency: txn.currency,
          ...(txn.subscriptionId ? { subscription_id: txn.subscriptionId } : {}),
          ...(txn.notes ? { notes: txn.notes } : {}),
          source: `donation-sync-${txn.source}`,
        }
      : {
          ...(txn.txnId ? { bank_reference: txn.txnId } : {}),
          currency: txn.currency,
          ...(txn.notes ? { notes: txn.notes } : {}),
          source: `donation-sync-${txn.source}`,
        };

  return new Order({
    user: user._id,
    donationId,
    items: [{ title: txn.title, price: txn.gross, quantity: 1 }],
    paymentType: "single",
    donationType: "Sadaqa",
    adminCostContribution: { included: false, amount: 0 },
    donorDetails: {
      name: user.name || [user.firstName, user.lastName].filter(Boolean).join(" "),
      phone: user.phone,
      email: user.email,
      address: {
        street: address.street || "",
        city: address.city || "",
        state: address.state || "",
        postcode: address.postcode || address.postalCode || "",
      },
      agreeToMessages: false,
    },
    paymentMethod: method,
    paymentStatus: "completed",
    totalAmount: txn.gross,
    lastPaymentDate: when,
    ...(method === "paypal" && txn.txnId
      ? {
          paypalDetails: {
            paymentId: txn.txnId,
            status: "COMPLETED",
            lastPaymentDate: when,
            lastPaymentId: txn.txnId,
            lastUpdated: when,
            paymentCompleted: true,
          },
        }
      : {}),
    transactionDetails,
  });
};

/**
 * Write the admin-confirmed transactions. Every duplicate check runs again
 * here, so re-committing (or committing a stale preview) is harmless.
 * Insert-only: nothing is updated or deleted besides appending recurring
 * payment history.
 */
const commitForUser = async (user, transactions) => {
  const results = [];

  for (const txn of transactions) {
    const verdict = await classifyTransaction(user, txn);

    if (verdict.action === "skip") {
      results.push({ txnId: txn.txnId, status: "skipped", reason: verdict.reason });
      continue;
    }

    if (verdict.action === "recurring") {
      const order = await Order.findById(verdict.recurringOrderId);
      const when = new Date(txn.date);
      order.recurringDetails.paymentHistory.push({
        date: when,
        amount: txn.gross,
        invoiceId: txn.txnId,
        status: "succeeded",
      });
      order.recurringDetails.paymentHistory.sort((a, b) => a.date - b.date);
      order.recurringDetails.totalPayments = order.recurringDetails.paymentHistory.length;
      if (!order.user) order.user = user._id; // link so statements find it
      if (
        !order.paypalDetails?.lastPaymentDate ||
        order.paypalDetails.lastPaymentDate < when
      ) {
        order.paypalDetails = {
          ...(order.paypalDetails?.toObject?.() || order.paypalDetails || {}),
          lastPaymentDate: when,
          lastPaymentId: txn.txnId,
          lastUpdated: new Date(),
        };
      }
      await order.save();
      results.push({
        txnId: txn.txnId,
        status: "recurring-payment-added",
        donationId: order.donationId,
      });
      continue;
    }

    const donationId = await generateUniqueDonationId();
    const order = buildOneTimeOrder(user, txn, donationId);
    await order.save();
    // Mongoose stamped "now"; move timestamps back to the real payment time so
    // the statement's FY range query (which filters on createdAt) sees it.
    // Must go through the native driver: timestamps mark createdAt immutable,
    // so a Mongoose updateOne silently drops the backdate (see
    // scripts/fixBackfillDates.js for the earlier instance of this bug).
    const when = new Date(txn.date);
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { createdAt: when, updatedAt: when } }
    );
    results.push({ txnId: txn.txnId, status: "inserted", donationId });
  }

  return results;
};

// ------------------------------ fill-out templates -------------------------

const TEMPLATE_HEADERS = [
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

const TEMPLATE_SAMPLES = {
  bank: [
    ["bank", "15/03/2025", "", "250.00", "", "NAB-REF-123456", "donor@example.com", "John Smith", "Zakat", "Direct deposit shown on bank statement"],
    ["bank", "02/04/2025", "14:30", "100.00", "", "", "", "", "Sadaqa", "Reference unknown — duplicate check uses amount and date"],
  ],
  paypal: [
    ["paypal", "15/03/2025", "", "303.64", "3.64", "3SR51322K99789303", "donor@example.com", "John Smith", "Educate a Child", "17-character ID from the PayPal transaction"],
    ["paypal", "02/04/2025", "18:45", "101.42", "1.42", "2DM404134H657511V", "", "", "Sadaqa", ""],
  ],
};

/**
 * Build the example .xlsx admins download, fill out and upload back
 * (method: 'bank' | 'paypal' — same columns, different sample rows).
 * Returns a Buffer.
 */
const buildTemplateWorkbook = (method) => {
  const rows = TEMPLATE_SAMPLES[method] || TEMPLATE_SAMPLES.bank;
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...rows]);
  ws["!cols"] = [28, 18, 18, 12, 16, 32, 26, 20, 24, 40].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Donations");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

module.exports = {
  parseUploadedFile,
  buildTemplateWorkbook,
  fetchPaypalTransactions,
  previewForUser,
  commitForUser,
};
