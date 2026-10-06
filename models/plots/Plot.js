const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { RECORD_STATUSES, RATE_UNITS, PLOT_STATUSES, PLOT_FACINGS } = require('../../config/plotConfig');
const { round2 } = require('./shared');

/**
 * One plot — the unit that is held, sold and cancelled.
 *
 * totalPrice is always basePrice plus the admin's premium (extra % and/or a
 * fixed extra amount), recomputed on every save so it can never disagree with
 * its parts. A booking freezes it at the moment of sale.
 */
const plotSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    serial: { type: Number, required: true },
    block: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyBlock', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyCompany', required: true },

    width: { type: Number, required: true, min: 0 },
    length: { type: Number, required: true, min: 0 },
    size: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    rateUnit: { type: String, enum: Object.values(RATE_UNITS), required: true },
    basePrice: { type: Number, required: true, min: 0 },
    extraPct: { type: Number, default: 0, min: 0 },
    extraAmount: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, required: true, min: 0 },

    facing: { type: String, enum: [...PLOT_FACINGS, ''], default: '' },
    remark: { type: String, default: '', trim: true },

    status: { type: String, enum: Object.values(PLOT_STATUSES), default: PLOT_STATUSES.AVAILABLE, index: true },
    hold: {
      note: { type: String, default: '' },
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null }
    },
    currentBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotBooking', default: null },
    // Inactive plots stay on record but cannot be held or sold.
    recordStatus: { type: String, enum: Object.values(RECORD_STATUSES), default: RECORD_STATUSES.ACTIVE }
  },
  { timestamps: true }
);

plotSchema.index({ block: 1, serial: 1 }, { unique: true });

const priceOf = ({ size, rate, rateUnit }) => round2(rateUnit === RATE_UNITS.PER_SQFT ? size * rate : rate);

plotSchema.pre('validate', function computePrice() {
  this.size = round2(this.width * this.length);
  this.basePrice = priceOf(this);
  this.totalPrice = round2(this.basePrice * (1 + (this.extraPct || 0) / 100) + (this.extraAmount || 0));
});

plotSchema.statics.priceOf = priceOf;

module.exports = bindModel('PropertyPlot', plotSchema, { only: BUSINESSES.T2 });
