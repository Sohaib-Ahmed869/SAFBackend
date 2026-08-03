// routes/admin/donorRoutes.js
const express    = require("express");
const router     = express.Router();
const isAdmin    = require("../../middleware/isAdmin");
const Order      = require("../../models/order");
const User       = require("../../models/user");
const PaymentMethod = require("../../models/paymentMethods");
const GoFundMe   = require("../../models/goFundMe");
const MergeLog   = require("../../models/mergeLog");
const stripeLib  = require("stripe");
const crypto     = require("crypto");
const bcrypt     = require("bcrypt");
const { sendEmail } = require("../../services/emailUtil");

// Helper: calculate full expected amount for recurring orders
function calculateRecurringTotalAmount(order) {
  if (!order.recurringDetails) return 0;
  const { amount, frequency, startDate, endDate, totalPayments } = order.recurringDetails;
  if (!startDate || !endDate) {
    return (totalPayments || 1) * amount;
  }
  const start = new Date(startDate), end = new Date(endDate);
  let count = 0;
  switch (frequency.toLowerCase()) {
    case "daily":
      count = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
      break;
    case "weekly":
      count = Math.ceil((end - start) / (1000 * 60 * 60 * 24 * 7)) + 1;
      break;
    case "monthly":
      count = (end.getFullYear() - start.getFullYear()) * 12
            + (end.getMonth() - start.getMonth()) + 1;
      break;
    case "yearly":
      count = end.getFullYear() - start.getFullYear() + 1;
      break;
    default:
      count = totalPayments || 1;
  }
  return count * amount;
}

// GET /admin/donors/dashboard/stats
router.get("/dashboard/stats", isAdmin, async (req, res) => {
  try {
    const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);
    const allOrders   = await Order.find({}).lean();
    const validOrders = allOrders.filter(o => o.paymentStatus !== "failed");

    let totalDonated = 0, paidDonated = 0;
    let activeRecurring = 0, recurringCount = 0, oneTimeCount = 0, installmentCount = 0;
    let completedCount = 0, monthlyMRR = 0;
    const donorTotals = new Map();

    await Promise.all(validOrders.map(async o => {
      const { user, paymentType, paymentStatus, totalAmount, installmentDetails,
              transactionDetails, recurringDetails } = o;
      if (!user) return;
      const uid = user.toString();
      donorTotals.set(uid, (donorTotals.get(uid) || 0) + totalAmount);

      if (["completed", "succeeded"].includes(paymentStatus)) completedCount++;
      if (paymentType === "recurring") recurringCount++;
      else if (paymentType === "installments") installmentCount++;
      else oneTimeCount++;

      // One-time
      if (!paymentType || ["single","one_time"].includes(paymentType)) {
        totalDonated += totalAmount;
        if (paymentStatus === "completed") paidDonated += totalAmount;
      }
      // Installments
      else if (paymentType === "installments" && installmentDetails) {
        const { numberOfInstallments, installmentAmount, installmentsPaid } = installmentDetails;
        const paidCnt = installmentsPaid || 0;
        const expected = paymentStatus === "cancelled"
          ? paidCnt * installmentAmount
          : numberOfInstallments * installmentAmount;
        totalDonated += expected;
        paidDonated  += paidCnt * installmentAmount;
        if (paymentStatus !== "cancelled") monthlyMRR += installmentAmount;
        if (["active","pending"].includes(paymentStatus)) activeRecurring++;
      }
      // Recurring
      else if (paymentType === "recurring" && recurringDetails) {
        const expected = calculateRecurringTotalAmount(o);
        totalDonated += expected;
        let paidAmt = 0;
        if (transactionDetails?.stripeSubscriptionId) {
          try {
            const inv = await stripe.invoices.list({
              subscription: transactionDetails.stripeSubscriptionId,
              status: "paid", limit: 100
            });
            paidAmt = inv.data.reduce((s,i) => s + i.amount_paid/100, 0);
          } catch (stripeError) {
            console.warn(`Failed to fetch invoices for subscription ${transactionDetails.stripeSubscriptionId}:`, stripeError.message);
            // Fall back to local payment history
            if (Array.isArray(recurringDetails.paymentHistory)) {
              paidAmt = recurringDetails.paymentHistory
                .filter(p => ["succeeded","completed"].includes(p.status))
                .reduce((s,p) => s + (p.amount||0), 0);
            }
          }
        }
        if (!paidAmt && Array.isArray(recurringDetails.paymentHistory)) {
          paidAmt = recurringDetails.paymentHistory
            .filter(p => ["succeeded","completed"].includes(p.status))
            .reduce((s,p) => s + (p.amount||0), 0);
        }
        paidDonated += paidAmt;
        if (paidAmt > 0) {
          const amt = recurringDetails.amount;
          const freq = recurringDetails.frequency.toLowerCase();
          let m = freq === "weekly" ? amt*4.33
                : freq === "yearly" ? amt/12
                : freq === "quarterly"? amt/3
                : amt;
          monthlyMRR += m;
        }
        if (["active","pending"].includes(paymentStatus)) activeRecurring++;
      }
    }));

    const totalDonors    = donorTotals.size;
    const avgDonation    = totalDonors ? totalDonated/totalDonors : 0;
    const recurringDonors= new Set(allOrders
      .filter(o => o.paymentType==="recurring" && o.paymentStatus!=="failed" && o.user)
      .map(o => o.user ? o.user.toString() : null)
      .filter(uid => uid)
    ).size;

    res.json({
      status: "Success",
      data: {
        stats: {
          totalDonors,
          totalDonations: Number(totalDonated.toFixed(2)),
          averageDonation: Number(avgDonation.toFixed(2)),
          recurringDonations: recurringDonors,
          successRate: allOrders.length
            ? Number(((validOrders.length/allOrders.length)*100).toFixed(2))
            : 0,
          monthlyRecurringRevenue: Number(monthlyMRR.toFixed(2))
        },
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status:"Error", message:"Failed to fetch dashboard statistics", error:err.message });
  }
});

// GET /admin/donors/
router.get("/", isAdmin, async (req, res) => {
  try {
    const page      = parseInt(req.query.page)  || 1;
    const limit     = parseInt(req.query.limit) || 10;
    const search    = (req.query.search || "").toLowerCase();
    const sortBy    = req.query.sortBy  || "totalPaid";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    const type      = req.query.type    || "All";
    const skip      = (page - 1) * limit;

    const allOrders = await Order.find({ paymentStatus: { $ne: "failed" } })
      .populate("user", "name email phone address country dateOfBirth")
      .lean();

    const map = new Map();
    allOrders.forEach(o => {
      if (!o.user || !o.user._id) return;
      const uid = o.user._id.toString();
      if (!map.has(uid)) map.set(uid, { user: o.user, orders: [] });
      map.get(uid).orders.push(o);
    });

    let donors = Array.from(map.values()).map(({ user, orders }) => {
      if (!user) return null;
      // split full name
      const [ firstName, ...rest ] = (user.name || "").trim().split(" ");
      const lastName = rest.join(" ");

      // build full address
      const addr = user.address || {};
      const fullAddress = [
        addr.street,
        addr.city,
        addr.state,
        addr.postalCode
      ].filter(Boolean).join(", ");

      let totalPaid     = 0;
      let totalExpected = 0;
      let firstDate, lastDate;
      const types = [];

      orders.forEach(o => {
        types.push(o.paymentType);
        const dt = new Date(o.createdAt);
        if (!firstDate || dt < firstDate) firstDate = dt;
        if (!lastDate  || dt > lastDate)  lastDate  = dt;

        // one-time
        if (!o.paymentType || ["single","one_time"].includes(o.paymentType)) {
          totalExpected += o.totalAmount;
          if (o.paymentStatus === "completed") {
            totalPaid += o.totalAmount;
          }
        }
        // installments
        else if (o.paymentType === "installments" && o.installmentDetails) {
          const { numberOfInstallments, installmentAmount, installmentsPaid } = o.installmentDetails;
          const exp = o.paymentStatus === "cancelled"
            ? (installmentsPaid||0) * installmentAmount
            : numberOfInstallments * installmentAmount;
          totalExpected += exp;
          totalPaid     += (installmentsPaid||0) * installmentAmount;
        }
        // recurring
        else if (o.paymentType === "recurring" && o.recurringDetails) {
          totalExpected += calculateRecurringTotalAmount(o);
          if (Array.isArray(o.recurringDetails.paymentHistory)) {
            totalPaid += o.recurringDetails.paymentHistory
              .filter(p => ["succeeded","completed"].includes(p.status))
              .reduce((sum,p) => sum + (p.amount||0), 0);
          }
        }
      });

      let donationType = "one-time";
      if (types.includes("recurring")) donationType = "recurring";
      else if (types.includes("installments")) donationType = "installments";

      return {
        _id:               user._id,
        name:              user.name,
        firstName,                             // ← added
        lastName,                              // ← added
        email:             user.email,
        phone:             user.phone,
        address:           user.address,
        fullAddress,                           // ← added
        country:           user.country,       // add this line
        dateOfBirth:               user.dateOfBirth,    // ← added (alias for dateOfBirth)
        totalPaid:         Number(totalPaid.toFixed(2)),
        totalExpected:     Number(totalExpected.toFixed(2)),
        donationCount:     orders.length,
        firstDonationDate: firstDate?.toISOString(),
        lastDonationDate:  lastDate?.toISOString(),
        donationTypes:     types,
        donationType
      };
    });
    donors = donors.filter(Boolean);

    // Manually added donor records (created from the admin panel) have no
    // orders yet, so the order-derived list above misses them. Append them
    // with zero totals so they can be found and their donations synced.
    const manualUsers = await User.find({ createdByAdmin: true })
      .select("name email phone address country dateOfBirth")
      .lean();
    manualUsers.forEach((user) => {
      if (map.has(user._id.toString())) return; // already listed via orders
      const [firstName, ...rest] = (user.name || "").trim().split(" ");
      const addr = user.address || {};
      donors.push({
        _id:               user._id,
        name:              user.name,
        firstName,
        lastName:          rest.join(" "),
        email:             user.email,
        phone:             user.phone,
        address:           user.address,
        fullAddress:       [addr.street, addr.city, addr.state, addr.postalCode]
                             .filter(Boolean).join(", "),
        country:           user.country,
        dateOfBirth:       user.dateOfBirth,
        totalPaid:         0,
        totalExpected:     0,
        donationCount:     0,
        firstDonationDate: null,
        lastDonationDate:  null,
        donationTypes:     [],
        donationType:      "one-time",
      });
    });

    // 5) search
    if (search) {
      donors = donors.filter(d =>
        d.name.toLowerCase().includes(search) ||
        d.email.toLowerCase().includes(search)
      );
    }
    // 6) type filter
    if (type !== "All") {
      const tf = type === "single" ? "one-time" : type;
      donors = donors.filter(d => d.donationType === tf);
    }
    // 7) sort
    donors.sort((a,b) =>
      ((a[sortBy]||0) - (b[sortBy]||0)) * sortOrder
    );
    // 8) paginate
    const total = donors.length;
    const paged = donors.slice(skip, skip + limit);

    res.json({
      status: "Success",
      data: {
        donors: paged,
        pagination: {
          total,
          pages:       Math.ceil(total / limit),
          currentPage: page,
          perPage:     limit
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status:  "Error",
      message: "Failed to fetch donors",
      error:   err.message
    });
  }
});



// GET /admin/donors/lookup?email=...
// Look up a single user by email so the admin can preview an account before merging.
// NOTE: must be declared before the "/:id" route, otherwise "lookup" is captured as an id.
router.get("/lookup", isAdmin, async (req, res) => {
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ status: "Error", message: "Email is required" });
    }

    const user = await User.findOne({ email }).lean();
    if (!user) {
      return res.status(404).json({ status: "Error", message: "No user found with that email" });
    }

    const donationCount = await Order.countDocuments({
      user: user._id,
      paymentStatus: { $ne: "failed" },
    });

    res.json({
      status: "Success",
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        donationCount,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "Error", message: "Failed to look up user", error: err.message });
  }
});

// POST /admin/donors/
// Manually create a donor record for someone who gave off-site (bank transfer,
// PayPal outside the website) and therefore has no account. The account gets a
// random temporary password; the donation-sync flow can then attach their past
// donations. Donors with no known email get a unique placeholder address and
// are flagged isPlaceholderEmail so mail is never sent to them.
// Body: { name, email?, phone?, address?, sendWelcomeEmail? }
router.post("/", isAdmin, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    let email = (req.body.email || "").trim().toLowerCase();
    const phone = (req.body.phone || "").trim();
    const address = req.body.address || {};

    if (!name) {
      return res.status(400).json({ status: "Error", message: "Name is required" });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ status: "Error", message: "Invalid email address" });
    }

    const isPlaceholderEmail = !email;
    if (isPlaceholderEmail) {
      email = `donor-${crypto.randomBytes(6).toString("hex")}@noemail.shahidafridifoundation.org.au`;
    } else {
      const existing = await User.findOne({ email }).lean();
      if (existing) {
        const donationCount = await Order.countDocuments({
          user: existing._id,
          paymentStatus: { $ne: "failed" },
        });
        return res.status(409).json({
          status: "Error",
          message: "A user with that email already exists",
          data: {
            existing: {
              _id: existing._id,
              name: existing.name,
              email: existing.email,
              phone: existing.phone,
              donationCount,
            },
          },
        });
      }
    }

    const password = crypto.randomBytes(8).toString("hex");
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      phone: phone || undefined,
      address: {
        street: (address.street || "").trim() || undefined,
        city: (address.city || "").trim() || undefined,
        state: (address.state || "").trim() || undefined,
        postalCode: (address.postalCode || "").trim() || undefined,
      },
      role: "user",
      isTemporaryPassword: true,
      isPlaceholderEmail,
      createdByAdmin: true,
      ...(isPlaceholderEmail && {
        notifications: {
          emailNotifications: false,
          donationReceipts: false,
          monthlyNewsletter: false,
          impactUpdates: false,
        },
      }),
    });

    let welcomeEmailSent = false;
    if (!isPlaceholderEmail && req.body.sendWelcomeEmail) {
      const loginUrl = "https://shahidafridifoundation.org.au/login";
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
          <h2 style="color: #4CAF50; text-align: center;">Welcome to the Shahid Afridi Foundation</h2>
          <p>Dear ${name},</p>
          <p>Thank you for supporting the Shahid Afridi Foundation. We've created an account for you so you can track your donations and download your annual tax statements.</p>
          <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Your Account Details:</strong></p>
            <p>Email: ${email}</p>
            <p>Password: ${password}</p>
            <p style="font-size: 12px; color: #666;">You will be asked to choose a new password on your first login.</p>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${loginUrl}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; border-radius: 4px; font-weight: bold;">Login to Your Account</a>
          </div>
          <p>If you have any questions or need assistance, please don't hesitate to contact our team.</p>
          <p>Warm regards,<br>The Shahid Afridi Foundation Team</p>
          <div style="font-size: 12px; color: #666; border-top: 1px solid #e0e0e0; margin-top: 20px; padding-top: 20px;">
            <p>This is an automated email. Please do not reply to this message.</p>
          </div>
        </div>`;
      try {
        const result = await sendEmail(
          email,
          emailBody,
          "Welcome to Shahid Afridi Foundation - Your Account Details"
        );
        welcomeEmailSent = Boolean(result?.success ?? true);
      } catch (emailErr) {
        console.error("Failed to send welcome email:", emailErr);
      }
    }

    res.status(201).json({
      status: "Success",
      message: `Donor record created for ${name}`,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address,
        isPlaceholderEmail,
        welcomeEmailSent,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "Error", message: "Failed to create donor", error: err.message });
  }
});

// POST /admin/donors/merge
// Merge a secondary account into a primary account: reassign every reference that
// points at the secondary user (donations, payment methods, campaigns, etc.) to the
// primary user, then delete the now-empty secondary account.
// Body: { primaryEmail, secondaryEmail }
router.post("/merge", isAdmin, async (req, res) => {
  try {
    const primaryEmail = (req.body.primaryEmail || "").trim().toLowerCase();

    // Accept either a single `secondaryEmail` or an array `secondaryEmails`.
    let secondaryEmails = req.body.secondaryEmails;
    if (!Array.isArray(secondaryEmails)) {
      secondaryEmails = req.body.secondaryEmail ? [req.body.secondaryEmail] : [];
    }
    secondaryEmails = [
      ...new Set(secondaryEmails.map((e) => (e || "").trim().toLowerCase()).filter(Boolean)),
    ];

    if (!primaryEmail || secondaryEmails.length === 0) {
      return res.status(400).json({
        status: "Error",
        message: "primaryEmail and at least one secondary email are required",
      });
    }
    if (secondaryEmails.includes(primaryEmail)) {
      return res.status(400).json({
        status: "Error",
        message: "The primary account cannot also be listed as a secondary account",
      });
    }

    const primary = await User.findOne({ email: primaryEmail });
    if (!primary) {
      return res.status(404).json({ status: "Error", message: `Primary account not found: ${primaryEmail}` });
    }

    // Resolve and validate every secondary up front (all-or-nothing on validation).
    const secondaryUsers = [];
    for (const email of secondaryEmails) {
      const u = await User.findOne({ email });
      if (!u) {
        return res.status(404).json({ status: "Error", message: `Secondary account not found: ${email}` });
      }
      if (u.role === "admin") {
        return res.status(403).json({ status: "Error", message: `Cannot merge away an admin account: ${email}` });
      }
      secondaryUsers.push(u);
    }

    const primaryId = primary._id;
    const idsOf = (docs) => docs.map((d) => d._id);
    const secondaries = [];

    // Fold each secondary into the primary.
    for (const sec of secondaryUsers) {
      const secId = sec._id;

      // Capture the exact ids being moved BEFORE updating, so a future reverse can move
      // back only these records (not ones that already belonged to the primary).
      const [orderIds, paymentMethodIds, campaignIds, approvalCampaignIds, cancellationOrderIds] =
        await Promise.all([
          Order.find({ user: secId }, { _id: 1 }).lean().then(idsOf),
          PaymentMethod.find({ user: secId }, { _id: 1 }).lean().then(idsOf),
          GoFundMe.find({ userId: secId }, { _id: 1 }).lean().then(idsOf),
          GoFundMe.find({ approvedBy: secId }, { _id: 1 }).lean().then(idsOf),
          Order.find({ "cancellationDetails.cancelledBy": secId }, { _id: 1 }).lean().then(idsOf),
        ]);

      // Snapshot verbatim (incl. _id, password hash, timestamps) for an exact restore.
      const snapshot = sec.toObject();

      await Promise.all([
        Order.updateMany({ _id: { $in: orderIds } }, { $set: { user: primaryId } }),
        PaymentMethod.updateMany({ _id: { $in: paymentMethodIds } }, { $set: { user: primaryId } }),
        GoFundMe.updateMany({ _id: { $in: campaignIds } }, { $set: { userId: primaryId } }),
        GoFundMe.updateMany({ _id: { $in: approvalCampaignIds } }, { $set: { approvedBy: primaryId } }),
        Order.updateMany(
          { _id: { $in: cancellationOrderIds } },
          { $set: { "cancellationDetails.cancelledBy": primaryId } }
        ),
      ]);

      await User.findByIdAndDelete(secId);

      secondaries.push({
        user: { userId: secId, email: sec.email, name: sec.name },
        snapshot,
        reassigned: { orderIds, paymentMethodIds, campaignIds, approvalCampaignIds, cancellationOrderIds },
      });
    }

    // Record the merge (one log for the whole batch) so it can be reversed later.
    const log = await MergeLog.create({
      primaryUser: { userId: primaryId, email: primary.email, name: primary.name },
      secondaries,
      status: "merged",
      mergedBy: req.user._id,
    });

    const sum = (key) =>
      secondaries.reduce((acc, s) => acc + (s.reassigned[key] || []).length, 0);
    const summary = {
      accountsMerged:           secondaries.length,
      ordersReassigned:         sum("orderIds"),
      paymentMethodsReassigned: sum("paymentMethodIds"),
      campaignsReassigned:      sum("campaignIds"),
      approvalsReassigned:      sum("approvalCampaignIds"),
      cancellationsReassigned:  sum("cancellationOrderIds"),
    };

    res.json({
      status: "Success",
      message:
        secondaries.length === 1
          ? `Merged ${secondaries[0].user.email} into ${primary.email}`
          : `Merged ${secondaries.length} accounts into ${primary.email}`,
      data: {
        mergeId: log._id,
        primary: { _id: primaryId, email: primary.email, name: primary.name },
        secondaries: secondaries.map((s) => s.user),
        summary,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "Error", message: "Failed to merge accounts", error: err.message });
  }
});

// GET /admin/donors/search-users?search=
// Search the User collection directly (by name or email) for the merge picker.
// Unlike GET /admin/donors (which is derived from orders and therefore only lists
// people who have donated), this returns ALL accounts — including ones with no
// donations yet — each annotated with its donation count.
router.get("/search-users", isAdmin, async (req, res) => {
  try {
    const q = (req.query.search || "").trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    let filter = {};
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");
      filter = { $or: [{ email: rx }, { name: rx }] };
    }

    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("name email phone role")
      .lean();

    // Annotate each with its (non-failed) donation count.
    const ids = users.map((u) => u._id);
    const counts = await Order.aggregate([
      { $match: { user: { $in: ids }, paymentStatus: { $ne: "failed" } } },
      { $group: { _id: "$user", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

    const result = users.map((u) => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      donationCount: countMap.get(String(u._id)) || 0,
    }));

    res.json({ status: "Success", data: { users: result } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "Error", message: "Failed to search users", error: err.message });
  }
});

// GET /admin/donors/merges
// List merge history (most recent first) so the admin can review/reverse merges.
router.get("/merges", isAdmin, async (req, res) => {
  try {
    const logs = await MergeLog.find({})
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit) || 100)
      .lean();

    const merges = logs.map((l) => {
      const secs = l.secondaries || [];
      const sum = (key) =>
        secs.reduce((acc, s) => acc + (s.reassigned?.[key] || []).length, 0);
      return {
        _id:        l._id,
        primary:    l.primaryUser,
        secondaries: secs.map((s) => s.user),
        status:     l.status,
        mergedAt:   l.createdAt,
        reversedAt: l.reversedAt,
        summary: {
          accountsMerged:           secs.length,
          ordersReassigned:         sum("orderIds"),
          paymentMethodsReassigned: sum("paymentMethodIds"),
          campaignsReassigned:      sum("campaignIds"),
          approvalsReassigned:      sum("approvalCampaignIds"),
          cancellationsReassigned:  sum("cancellationOrderIds"),
        },
      };
    });

    res.json({ status: "Success", data: { merges } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "Error", message: "Failed to fetch merge history", error: err.message });
  }
});

// POST /admin/donors/merges/:id/reverse
// Undo a previous merge: restore the deleted secondary account verbatim and move the
// originally-reassigned records back to it.
router.post("/merges/:id/reverse", isAdmin, async (req, res) => {
  try {
    const log = await MergeLog.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ status: "Error", message: "Merge record not found" });
    }
    if (log.status === "reversed") {
      return res.status(400).json({ status: "Error", message: "This merge has already been reversed" });
    }

    const secondaries = log.secondaries || [];
    if (secondaries.length === 0 || secondaries.some((s) => !s.snapshot || !s.snapshot._id)) {
      return res.status(400).json({ status: "Error", message: "Merge record is missing account snapshots and cannot be reversed" });
    }

    // The primary account must still exist (records currently point to it).
    const primary = await User.findById(log.primaryUser.userId);
    if (!primary) {
      return res.status(409).json({ status: "Error", message: "The primary account no longer exists; cannot reverse this merge" });
    }

    // Pre-flight: the secondaries' emails/googleIds were freed on merge — make sure
    // nothing has claimed them since, or restoring would violate the unique indexes.
    // Validate ALL before restoring ANY so a reverse is all-or-nothing.
    for (const s of secondaries) {
      const snap = s.snapshot;
      const emailTaken = await User.findOne({ email: snap.email });
      if (emailTaken) {
        return res.status(409).json({
          status: "Error",
          message: `Cannot restore "${snap.email}" — that email is now used by another account`,
        });
      }
      if (snap.googleId) {
        const googleTaken = await User.findOne({ googleId: snap.googleId });
        if (googleTaken) {
          return res.status(409).json({
            status: "Error",
            message: `Cannot restore "${snap.email}" — its Google login is now linked to another account`,
          });
        }
      }
    }

    // Restore each secondary and move its records back.
    const restored = [];
    for (const s of secondaries) {
      const snap = s.snapshot;
      const secId = snap._id;

      // Restore verbatim (bypass middleware/validation so _id, password hash and
      // timestamps are preserved).
      await User.collection.insertOne(snap);

      const r = s.reassigned || {};
      await Promise.all([
        Order.updateMany({ _id: { $in: r.orderIds || [] } }, { $set: { user: secId } }),
        PaymentMethod.updateMany({ _id: { $in: r.paymentMethodIds || [] } }, { $set: { user: secId } }),
        GoFundMe.updateMany({ _id: { $in: r.campaignIds || [] } }, { $set: { userId: secId } }),
        GoFundMe.updateMany({ _id: { $in: r.approvalCampaignIds || [] } }, { $set: { approvedBy: secId } }),
        Order.updateMany(
          { _id: { $in: r.cancellationOrderIds || [] } },
          { $set: { "cancellationDetails.cancelledBy": secId } }
        ),
      ]);

      restored.push({ _id: secId, email: snap.email, name: snap.name });
    }

    log.status = "reversed";
    log.reversedAt = new Date();
    log.reversedBy = req.user._id;
    await log.save();

    res.json({
      status: "Success",
      message:
        restored.length === 1
          ? `Reversed merge — restored ${restored[0].email}`
          : `Reversed merge — restored ${restored.length} accounts`,
      data: { mergeId: log._id, restored },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "Error", message: "Failed to reverse merge", error: err.message });
  }
});

// GET /admin/donors/:id
router.get("/:id", isAdmin, async (req, res) => {
  try {
    const donorId = req.params.id;
    const donor = await User.findById(donorId).lean();
    if (!donor) {
      return res.status(404).json({ status:"Error", message:"Donor not found" });
    }

    const orders = await Order.find({
      user: donorId,
      paymentStatus:{ $ne:"failed" }
    }).sort({ createdAt:-1 }).lean();

    const history=[];
    orders.forEach(o=>{
      if (!o.paymentType||["single","one_time"].includes(o.paymentType)) {
        if (o.paymentStatus==="completed") {
          history.push({ id:o._id.toString(), date:o.createdAt,
                         amount:o.totalAmount, status:o.paymentStatus,
                         type:"one-time", cause:o.items[0]?.title||"Multiple Items"
                       });
        }
      }
      else if (o.paymentType==="installments"&&o.installmentDetails) {
        const paidCnt=o.installmentDetails.installmentsPaid||0;
        const amt=paidCnt*o.installmentDetails.installmentAmount;
        if(paidCnt>0){
          history.push({ id:o._id.toString(), date:o.createdAt,
                         amount:amt, status:o.paymentStatus,
                         type:"installments", cause:o.items[0]?.title||"Multiple Items"
                       });
        }
      }
      else if (o.paymentType==="recurring"&&Array.isArray(o.recurringDetails.paymentHistory)){
        o.recurringDetails.paymentHistory
          .filter(p=>["succeeded","completed"].includes(p.status))
          .forEach(p=>{
            history.push({ id:p.invoiceId||p._id?.toString()||`${o._id}:${p.date}`,
                           date:p.date, amount:p.amount, status:p.status,
                           type:"recurring", cause:o.items[0]?.title||"Multiple Items"
                         });
          });
      }
    });

    history.sort((a,b)=>new Date(b.date)-new Date(a.date));
    const totalDonations=history.reduce((s,e)=>s+e.amount,0);

    res.json({
      status:"Success",
      data:{
        id: donor._id,
        name: donor.name,
        firstName: donor.name.split(" ")[0],
        lastName: donor.name.split(" ").slice(1).join(" "),
        email: donor.email,
        phone: donor.phone,
        address: donor.address,
        fullAddress: [donor.address?.street, donor.address?.city, donor.address?.state, donor.address?.postalCode]
                       .filter(Boolean).join(", "),
        donationHistory: history,
        totalDonations
      }
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ status:"Error", message:"Failed to fetch donor details", error:err.message });
  }
});

module.exports = router;
