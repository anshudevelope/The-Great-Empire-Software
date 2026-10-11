const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { INSTALMENT_KINDS, INSTALMENT_STATUSES } = require('../../config/plotConfig');

/**
 * One instalment of a booking's schedule — what is owed and how much of it
 * has been paid. The money itself lives on PlotReceipt (one per payment),
 * whose allocations add up here.
 *
 * seq 0 is the full (one-time) or down payment; EMIs run 1…N. A prepayment
 * that reduces the EMI or the tenure marks the unpaid future rows
 * `superseded` and adds replacements with the next `revision`.
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
    revision: { type: Number, default: 0, min: 0 },
    dueDate: { type: Date, required: true, index: true },
    dueAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(INSTALMENT_STATUSES), default: INSTALMENT_STATUSES.DUE, index: true },

    // Builds up across receipts.
    paidAmount: { type: Number, default: 0, min: 0 },
    lastPaidOn: { type: Date, default: null }
  },
  { timestamps: true }
);

paymentSchema.index({ booking: 1, seq: 1, revision: 1 }, { unique: true });

module.exports = bindModel('PlotPayment', paymentSchema, { only: BUSINESSES.T2 });
