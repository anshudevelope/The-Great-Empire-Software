const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { PAYOUT_STATUSES } = require('../../config/constants');

const lineSchema = new mongoose.Schema(
  {
    member: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },
    memberCode: { type: String, required: true },
    fullName: { type: String, required: true },
    direct: { type: Number, default: 0 },
    matching: { type: Number, default: 0 },
    reversals: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    adminCharge: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    netPayable: { type: Number, default: 0 },
    rowCount: { type: Number, default: 0 }
  },
  { _id: false }
);

/**
 * A plot-commission closing. Separate from registration payouts.
 *
 * DRAFT  — lines computed, nothing stamped; discardable.
 * FINALIZED — every included ledger row is stamped with this payout in one
 *             transaction, so a row can be paid at most once.
 * CANCELLED — the stamps are lifted; the rows are unpaid again.
 *
 * A member whose period nets to zero or less gets no line and their rows stay
 * unstamped, rolling into the next closing on their own.
 */
const plotPayoutSchema = new mongoose.Schema(
  {
    payoutNo: { type: String, required: true, unique: true },
    status: { type: String, enum: Object.values(PAYOUT_STATUSES), default: PAYOUT_STATUSES.DRAFT },
    periodEnd: { type: Date, required: true },
    // Charges frozen at generation; changing plotConfig never moves a payout.
    rates: {
      adminChargePct: { type: Number, required: true },
      tdsPct: { type: Number, required: true }
    },
    lines: { type: [lineSchema], default: [] },
    totals: {
      members: { type: Number, default: 0 },
      direct: { type: Number, default: 0 },
      matching: { type: Number, default: 0 },
      reversals: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      adminCharge: { type: Number, default: 0 },
      tds: { type: Number, default: 0 },
      netPayable: { type: Number, default: 0 }
    },
    note: { type: String, default: '' },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    cancelReason: { type: String, default: '' }
  },
  { timestamps: true }
);

// At most one draft at a time — two drafts would both claim the same rows.
// Named, so it can never collide with an auto-named index on the same key.
plotPayoutSchema.index(
  { status: 1 },
  { name: 'one_draft_at_a_time', unique: true, partialFilterExpression: { status: PAYOUT_STATUSES.DRAFT } }
);

module.exports = bindModel('PlotPayout', plotPayoutSchema, { only: BUSINESSES.T2 });
