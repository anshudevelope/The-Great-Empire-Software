const mongoose = require('mongoose');
const { PAYOUT_STATUSES } = require('../config/constants');

/**
 * One closing run.
 *
 * The client closes the books whenever they choose, pays everyone what they
 * have earned, and everybody restarts from zero. This document is that event.
 *
 * Lifecycle:
 *   DRAFT      built from the ledger, nothing committed, fully discardable
 *   FINALIZED  ledger rows stamped, member income zeroed, carry flushed
 *   CANCELLED  a finalized batch undone from the snapshots on its lines
 *
 * "Everyone starts from zero" is implemented by STAMPING, never by deleting:
 * finalizing sets `payoutBatch` on every ledger row it covers, so the sum of
 * unstamped rows — which is what the tree tooltip shows — becomes zero on its
 * own. No history is destroyed and every past figure stays queryable.
 */
const payoutBatchSchema = new mongoose.Schema(
  {
    batchNo: { type: String, required: true, unique: true, uppercase: true, trim: true },

    // The window this batch covers. `periodEnd` is the cutoff the admin chose;
    // commission earned after it belongs to the next batch, which is what makes
    // the on-screen preview trustworthy — nothing can be swept in between the
    // admin reading the page and pressing Finalize.
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    // No `index: true` here on purpose — the partial unique index declared at
    // the bottom of this file covers the same { status: 1 } key. MongoDB will
    // not create a second index with the same key pattern but different
    // options, so declaring both leaves the plain one in place and the
    // one-draft-at-a-time rule silently unenforced. Same trap as Referral.member.
    status: {
      type: String,
      enum: Object.values(PAYOUT_STATUSES),
      default: PAYOUT_STATUSES.DRAFT
    },

    // Rates as they stood when this batch was generated, frozen. Editing the
    // Setting collection afterwards must never move a historical payout.
    rates: {
      adminChargePct: { type: Number, required: true },
      secondaryChargePct: { type: Number, required: true },
      secondaryChargeLabel: { type: String, default: 'TDS' },
      flushCarryOnClose: { type: Boolean, required: true },
      minimumPayable: { type: Number, default: 0 }
    },

    totals: {
      members: { type: Number, default: 0 }, // lines with a non-zero total
      grossDirect: { type: Number, default: 0 },
      grossMatching: { type: Number, default: 0 },
      grossReversals: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      adminCharge: { type: Number, default: 0 },
      secondaryCharge: { type: Number, default: 0 },
      netPayable: { type: Number, default: 0 },
      // Volume destroyed by the flush. Recorded because it cannot be recovered
      // and because it is the number the client should be looking at.
      carryFlushed: { type: Number, default: 0 },
      ledgerRows: { type: Number, default: 0 }
    },

    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },
    generatedByCode: { type: String, default: '' },

    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    finalizedAt: { type: Date, default: null },

    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    note: { type: String, default: '' }
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Only ONE draft may exist at a time.
//
// Two admins pressing "Generate" at the same moment would otherwise each build
// a batch over the same unpaid ledger rows, and whichever finalized second
// would pay everything twice. A partial unique index makes the second
// concurrent draft impossible at the database level rather than relying on the
// controller to check first.
//
// This must be the ONLY declaration on { status: 1 } (see the field above), and
// it only exists in MongoDB once `npm run sync:indexes` has run — autoIndex
// races the first write, which is no use for a constraint that has to hold
// before that write happens.
// ---------------------------------------------------------------------------
payoutBatchSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: PAYOUT_STATUSES.DRAFT } }
);

payoutBatchSchema.index({ createdAt: -1 });
payoutBatchSchema.index({ periodEnd: -1 });

module.exports = mongoose.model('PayoutBatch', payoutBatchSchema);
