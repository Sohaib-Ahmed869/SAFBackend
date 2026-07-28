/**
 * Admin endpoints for syncing a donor's missing PayPal donations before
 * generating their annual statement.
 *
 *  POST /api/admin/orders/paypal-sync/preview
 *    multipart (file + userId) — parse an uploaded PayPal activity export, OR
 *    JSON { userId, financialYear? | startDate?/endDate?, paypalEmail? } —
 *    pull from the PayPal Transaction Search API.
 *    Returns the normalised transactions annotated with what commit would do.
 *
 *  POST /api/admin/orders/paypal-sync/commit
 *    JSON { userId, transactions } — transactions are the rows the admin kept
 *    from the preview. Every duplicate check re-runs on commit, so this is
 *    idempotent and safe against stale previews.
 */

const User = require("../../models/user");
const {
  parseActivityExport,
  fetchPaypalTransactions,
  previewForUser,
  commitForUser,
} = require("../../services/paypalDonationSync");

const loadUser = async (userId, res) => {
  if (!userId) {
    res.status(400).json({ status: "Error", message: "userId is required" });
    return null;
  }
  const user = await User.findById(userId).select(
    "name firstName lastName email phone address"
  );
  if (!user) {
    res.status(404).json({ status: "Error", message: "Donor not found" });
    return null;
  }
  return user;
};

const resolveDateRange = ({ financialYear, startDate, endDate }) => {
  if (financialYear) {
    if (!/^\d{4}-\d{4}$/.test(financialYear)) {
      throw new Error("financialYear must be in YYYY-YYYY format");
    }
    const startYear = parseInt(financialYear.split("-")[0], 10);
    return {
      start: new Date(Date.UTC(startYear, 5, 30, 14, 0, 0)), // 1 Jul 00:00 AEST
      end: new Date(Date.UTC(startYear + 1, 5, 30, 13, 59, 59)), // 30 Jun 23:59 AEST
    };
  }
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      throw new Error("Invalid startDate/endDate range");
    }
    return { start, end };
  }
  throw new Error("Provide a financialYear (YYYY-YYYY) or a startDate and endDate");
};

const summarise = (rows) => ({
  total: rows.length,
  toInsert: rows.filter((r) => r.action === "insert").length,
  toAddToRecurring: rows.filter((r) => r.action === "recurring").length,
  alreadyRecorded: rows.filter((r) => r.action === "skip").length,
  emailMismatches: rows.filter((r) => !r.emailMatch).length,
});

exports.previewPaypalSync = async (req, res) => {
  try {
    const user = await loadUser(req.body.userId, res);
    if (!user) return;

    let transactions;
    let source;
    let notes = [];

    if (req.file) {
      source = "file";
      const parsed = parseActivityExport(req.file.buffer);
      transactions = parsed.transactions;
      if (parsed.ignored.length) {
        notes.push(
          `${parsed.ignored.length} row(s) in the file were ignored (not completed donation credits).`
        );
      }
      if (transactions.length === 0) {
        return res.status(400).json({
          status: "Error",
          message:
            "No completed donation payments found in the file. Make sure it is a PayPal activity export (.xlsx or .csv).",
          ignored: parsed.ignored,
        });
      }
    } else {
      source = "paypal";
      const { start, end } = resolveDateRange(req.body);
      const emails = [user.email, req.body.paypalEmail].filter(Boolean);
      const result = await fetchPaypalTransactions({
        startDate: start,
        endDate: end,
        emails,
      });
      transactions = result.transactions;
      if (result.clampedStart) {
        notes.push(
          `PayPal only allows searching the last 3 years — results start from ${result.clampedStart.slice(0, 10)}.`
        );
      }
    }

    const rows = await previewForUser(user, transactions);

    return res.json({
      status: "Success",
      source,
      user: { id: user._id, name: user.name, email: user.email },
      notes,
      summary: summarise(rows),
      transactions: rows,
    });
  } catch (error) {
    console.error("PayPal sync preview failed:", error.response?.data || error);
    // Transaction Search returns 403 when the API app doesn't have the
    // "Transaction Search" feature enabled — tell the admin what to do.
    if (error.response?.status === 403) {
      return res.status(502).json({
        status: "Error",
        message:
          "PayPal refused the transaction search (the API app may not have Transaction Search enabled). Upload the donor's PayPal activity export file instead.",
      });
    }
    return res.status(400).json({
      status: "Error",
      message: error.message || "Failed to build PayPal sync preview",
    });
  }
};

exports.commitPaypalSync = async (req, res) => {
  try {
    const user = await loadUser(req.body.userId, res);
    if (!user) return;

    const transactions = req.body.transactions;
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({
        status: "Error",
        message: "transactions array is required — run a preview first",
      });
    }
    for (const txn of transactions) {
      if (!txn.txnId || !txn.date || !(parseFloat(txn.gross) > 0)) {
        return res.status(400).json({
          status: "Error",
          message: `Invalid transaction in payload (txnId "${txn.txnId || "?"}") — re-run the preview`,
        });
      }
    }

    const results = await commitForUser(user, transactions);
    const inserted = results.filter((r) => r.status === "inserted").length;
    const recurring = results.filter((r) => r.status === "recurring-payment-added").length;
    const skipped = results.filter((r) => r.status === "skipped").length;

    return res.json({
      status: "Success",
      message: `Added ${inserted} donation(s)${recurring ? `, ${recurring} recurring payment(s)` : ""}${skipped ? `, skipped ${skipped} already recorded` : ""}.`,
      summary: { inserted, recurringPaymentsAdded: recurring, skipped },
      results,
    });
  } catch (error) {
    console.error("PayPal sync commit failed:", error);
    return res.status(500).json({
      status: "Error",
      message: error.message || "Failed to sync PayPal donations",
    });
  }
};
