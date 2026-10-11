const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { INSTALMENT_KINDS, PAYMENT_ADJUSTMENTS, PREPAYMENT } = require('../../config/plotConfig');
const { PAYMENT_MODES } = require('../../config/constants');
const { round2 } = require('./shared');

/**
 * One payment the admin recorded on a booking — and its printed receipt.
 *
 * The money is spread over the schedule as `allocations`: what is due first,
 * oldest first, then any extra the way the admin chose. A prepayment that
 * reshaped the schedule is a `prepayment` allocation with no instalment, and
 * `adjustment` keeps the schedule before and after so the receipt explains
 * itself later. Commission is settled per receipt (plots/commissionService).
 */
const allocationSchema = new mongoose.Schema(
  {
    instalment: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotPayment', default: null },
    seq: { type: Number, default: null },
    kind: { type: String, enum: [...Object.values(INSTALMENT_KINDS), PREPAYMENT], required: true },
    amount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const snapshotSchema = new mongoose.Schema(
  {
    count: { type: Number, required: true },
    emi: { type: Number, required: true },
    endDate: { type: Date, required: true }
  },
  { _id: false }
);

const adjustmentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: Object.values(PAYMENT_ADJUSTMENTS), required: true },
    extra: { type: Number, required: true, min: 0 },
    before: { type: snapshotSchema, default: null },
    after: { type: snapshotSchema, default: null }
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotBooking', required: true, index: true },
    plot: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyPlot', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotClient', required: true },
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    amount: { type: Number, required: true, min: 0.01 },
    paidOn: { type: Date, required: true, index: true },
    mode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
    // Share of the payment that earns commission (T1-style rating).
    ratingPct: { type: Number, default: 100, min: 0, max: 100 },
    commissionBase: { type: Number, default: 0, min: 0 },
    receiptNo: { type: String, required: true, unique: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    receivedByCode: { type: String, default: null },

    allocations: { type: [allocationSchema], default: [] },
    adjustment: { type: adjustmentSchema, default: null },
    // Booking balance right after this receipt.
    balanceAfter: { type: Number, required: true, min: 0 }
  },
  { timestamps: true }
);

// Derived here rather than by callers, so nothing can leave it out of step.
receiptSchema.pre('validate', function setCommissionBase() {
  this.commissionBase = round2((this.amount || 0) * ((this.ratingPct ?? 100) / 100));
});

module.exports = bindModel('PlotReceipt', receiptSchema, { only: BUSINESSES.T2 });
