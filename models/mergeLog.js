// models/mergeLog.js
// Records each account merge so it can be reversed. A single merge can fold one OR
// MANY secondary accounts into one primary; for every secondary we store a verbatim
// snapshot of the deleted user plus the exact ids of the records moved to the primary.
const mongoose = require("mongoose");

const partySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId },
    email: String,
    name: String,
  },
  { _id: false }
);

const reassignedSchema = new mongoose.Schema(
  {
    orderIds: [{ type: mongoose.Schema.Types.ObjectId }],
    paymentMethodIds: [{ type: mongoose.Schema.Types.ObjectId }],
    campaignIds: [{ type: mongoose.Schema.Types.ObjectId }],
    approvalCampaignIds: [{ type: mongoose.Schema.Types.ObjectId }],
    cancellationOrderIds: [{ type: mongoose.Schema.Types.ObjectId }],
  },
  { _id: false }
);

const secondarySchema = new mongoose.Schema(
  {
    user: partySchema,
    // Full raw document of the deleted secondary user, used to restore it on reverse.
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    // Exact ids moved from this secondary, so a reverse moves back ONLY these.
    reassigned: reassignedSchema,
  },
  { _id: false }
);

const mergeLogSchema = new mongoose.Schema(
  {
    primaryUser: partySchema,
    secondaries: [secondarySchema],
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
