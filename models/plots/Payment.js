const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { INSTALMENT_KINDS, INSTALMENT_STATUSES } = require('../../config/plotConfig');
const { PAYMENT_MODES } = require('../../config/constants');
const { round2 } = require('./shared');

/**
 * One instalment of a booking's schedule — and, once paid, its receipt.
 *
 * seq 0 is the full (one-time) or down payment; EMIs run 1…N. The schedule is
 * generated at sale (see scheduleService) and never re-shaped afterwards.
 */
const paymentSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotBooking', required: true },
    plot: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyPlot', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotClient', required: true },
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    kind: { type: String, enum: Object.values(INSTALMENT_KINDS), required: true },
    seq: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, required: true, index: true },
    dueAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(INSTALMENT_STATUSES), default: INSTALMENT_STATUSES.DUE, index: true },

    // --- Filled when received ---------------------------------------------
    paidAmount: { type: Number, default: 0, min: 0 },
    paidOn: { type: Date, default: null },
    mode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
    // Share of the payment that earns commission (T1-style rating).
    ratingPct: { type: Number, default: 100, min: 0, max: 100 },
    commissionBase: { type: Number, default: 0, min: 0 },
    receiptNo: { type: String, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    receivedByCode: { type: String, default: null }
  },
  { timestamps: true }
);

paymentSchema.index({ booking: 1, seq: 1 }, { unique: true });
// Receipts are unique once issued; unpaid rows have none.
paymentSchema.index({ receiptNo: 1 }, { unique: true, partialFilterExpression: { receiptNo: { $type: 'string' } } });

// Derived here rather than by callers, so nothing can leave it out of step.
paymentSchema.pre('validate', function setCommissionBase() {
  this.commissionBase = round2((this.paidAmount || 0) * ((this.ratingPct ?? 100) / 100));
});

module.exports = bindModel('PlotPayment', paymentSchema, { only: BUSINESSES.T2 });
