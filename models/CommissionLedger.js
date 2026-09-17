const mongoose = require('mongoose');
const { COMMISSION_TYPES, TIERS, POSITIONS } = require('../config/constants');

/**
 * One commission payment. Append-only.
 *
 * Nothing in this collection is ever updated or deleted. A mistake is corrected
 * by writing a REVERSAL row carrying the negative amount and pointing at the
 * original — so the history of what was paid, and what was later taken back,
 * both survive. An edited ledger cannot be audited.
 *
 * Every row also freezes the inputs it was computed from (`basis`). Rates change,
 * trees get restructured, members get renamed; a row from two years ago must
 * still be explainable without any of that context.
 */
const commissionLedgerSchema = new mongoose.Schema(
  {
    // ------------------------------------------------------------------
    // Idempotency — the single most important field in this schema.
    // ------------------------------------------------------------------
    // withTransaction() retries the whole callback up to 3 times on a
    // SlotTakenError. Without a unique key, one placement that retries twice
    // pays out three times. The UNIQUE INDEX below is the guard — not an
    // application-level "have we paid this already?" check, which is a
    // check-then-write race by construction.
    //
    //   direct:<referralId>
    //   match:<beneficiaryId>:<sourceMemberId>
    //   reversal:<originalLedgerId>
    idempotencyKey: { type: String, required: true },

    // Who is being paid.
    beneficiary: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    beneficiaryCode: { type: String, required: true },

    type: { type: String, enum: Object.values(COMMISSION_TYPES), required: true },

    // Snapshot of the SOURCE member's tier — the tier that generated the money,
    // not the beneficiary's. They are frequently different.
    tier: { type: String, enum: Object.values(TIERS), required: true },

    // Rupees. Negative on reversals. Rounded to 2dp at creation (see
    // commissionService.round2) — never at display time, which hides drift
    // instead of preventing it.
    amount: { type: Number, required: true },

    // ------------------------------------------------------------------
    // What triggered this row
    // ------------------------------------------------------------------
    // The member whose joining caused the payment. For a direct bonus that is
    // the referred member; for a matching bonus it is the member whose volume
    // completed the pair.
    sourceMember: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },
    sourceMemberCode: { type: String, required: true },
    sourceReferral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },

    // ------------------------------------------------------------------
    // Frozen inputs — enough to recompute this row from scratch
    // ------------------------------------------------------------------
    basis: {
      rate: { type: Number, required: true }, // 0.10 direct | 0.05 matching
      base: { type: Number, required: true }, // amountPaid, or the matched volume

      // Matching only: which leg the source member landed on relative to THIS
      // beneficiary, and the carry either side of the match. These four make a
      // matching row self-explaining in a dispute.
      legSide: { type: String, enum: [...Object.values(POSITIONS), null], default: null },
      carryLeftBefore: { type: Number, default: null },
      carryRightBefore: { type: Number, default: null },
      carryLeftAfter: { type: Number, default: null },
      carryRightAfter: { type: Number, default: null },

      // How far below the beneficiary the source member sits. 1 = direct child.
      depthFromSource: { type: Number, default: null }
    },

    // ------------------------------------------------------------------
    // Payout state
    // ------------------------------------------------------------------
    // null = earned but not yet paid ("current period"). Set once, when a
    // payout batch is finalized; cleared only by cancelling that batch.
    //
    // A row belongs to at most ONE batch, which is what makes paying the same
    // commission twice structurally impossible rather than something the code
    // has to remember to check. It is also how "everyone starts from zero"
    // works without deleting anything: current income is simply the sum of
    // rows where this is still null.
    payoutBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'PayoutBatch', default: null },

    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'CommissionLedger', default: null },
    note: { type: String, default: '' }
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// THE double-pay guard. A duplicate insert raises E11000, which
// commissionService catches and treats as "already paid, this is a retry".
commissionLedgerSchema.index({ idempotencyKey: 1 }, { unique: true });

commissionLedgerSchema.index({ beneficiary: 1, createdAt: -1 }); // member ledger page
commissionLedgerSchema.index({ sourceMember: 1 });               // "what did this member generate?"
commissionLedgerSchema.index({ type: 1, createdAt: -1 });        // admin filters + liability totals

// The aggregation every payout batch runs: unpaid rows, grouped by member.
// Compound so the unpaid filter and the grouping are served by one index.
commissionLedgerSchema.index({ payoutBatch: 1, beneficiary: 1 });

module.exports = mongoose.model('CommissionLedger', commissionLedgerSchema);
