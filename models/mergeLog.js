// models/mergeLog.js
// Records each account merge so it can be reversed: stores a verbatim snapshot of
// the deleted (secondary) user plus the exact ids of every record that was moved
// from the secondary account to the primary account.
const mongoose = require("mongoose");

const partySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId },
    email: String,
    name: String,
  },
  { _id: false }
);

const mergeLogSchema = new mongoose.Schema(
  {
    primaryUser: partySchema,
    secondaryUser: partySchema,
    // Full raw document of the deleted secondary user, used to restore it on reverse.
    secondarySnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    // Exact ids moved, so a reverse moves back ONLY these (not records that already
    // belonged to the primary account before the merge).
    reassigned: {
      orderIds: [{ type: mongoose.Schema.Types.ObjectId }],
      paymentMethodIds: [{ type: mongoose.Schema.Types.ObjectId }],
      campaignIds: [{ type: mongoose.Schema.Types.ObjectId }],
      approvalCampaignIds: [{ type: mongoose.Schema.Types.ObjectId }],
      cancellationOrderIds: [{ type: mongoose.Schema.Types.ObjectId }],
    },
    status: {
      type: String,
      enum: ["merged", "reversed"],
      default: "merged",
    },
    mergedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reversedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MergeLog", mergeLogSchema);
