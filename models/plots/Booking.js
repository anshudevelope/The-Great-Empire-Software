const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { BOOKING_STATUSES, PAYMENT_PLANS } = require('../../config/plotConfig');

/**
 * A plot sold to a client, credited to an associate. Its instalments live in
 * PlotPayment. `price` is frozen from the plot at the moment of sale, so a
 * later premium edit can never change what this client owes.
 */
const bookingSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    plot: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyPlot', required: true, index: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotClient', required: true, index: true },
    // Who the sale is credited to: earns the direct commission, and the volume
    // climbs their upline. Must be approved and placed at the time of sale.
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    associateCode: { type: String, required: true },

    plan: { type: String, enum: Object.values(PAYMENT_PLANS), required: true },
    price: { type: Number, required: true, min: 0 },
    downPayment: { type: Number, default: 0, min: 0 },
    tenureMonths: { type: Number, default: 0, min: 0 },
    emiAmount: { type: Number, default: 0, min: 0 },
    bookedOn: { type: Date, required: true },

    status: { type: String, enum: Object.values(BOOKING_STATUSES), default: BOOKING_STATUSES.ACTIVE, index: true },
    // Kept in step with PlotPayment inside the same transaction as each receipt.
    paidTotal: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },

    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null }, // the admin
    cancel: {
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
      reason: { type: String, default: '' },
      refundAmount: { type: Number, default: 0, min: 0 },
      refundMode: { type: String, default: '' },
      refundReference: { type: String, default: '' }
    }
  },
  { timestamps: true }
);

module.exports = bindModel('PlotBooking', bookingSchema, { only: BUSINESSES.T2 });
