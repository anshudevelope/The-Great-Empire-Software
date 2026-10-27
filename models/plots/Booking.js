const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { BOOKING_STATUSES, PAYMENT_PLANS } = require('../../config/plotConfig');
const { POSITIONS } = require('../../config/constants');

/**
 * A plot sold to a client, credited to an associate. Its instalments live in
 * PlotPayment. `price` is frozen from the plot (less any discount) at the
 * moment of sale, so a later premium edit can never change what this client owes.
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
    // Optional: the sale is placed in the associate's own Left or Right leg,
    // so its business counts toward their own matching (and still flows up).
    // null = upline only, the original behaviour.
    leg: { type: String, enum: [...Object.values(POSITIONS), null], default: null },

    plan: { type: String, enum: Object.values(PAYMENT_PLANS), required: true },
    // What the client pays: the plot's list price less any discount given at
    // sale. Instalments, receipts and so commission all work off this.
    price: { type: Number, required: true, min: 0 },
    // The plot's price when sold, and the discount off it. null on bookings
    // made before discounts existed (their price IS the list price).
    listPrice: { type: Number, default: null, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    // The project's Allotment % at sale: commission on this booking's payments
    // is held until paidTotal reaches this share of `price`. null on older
    // bookings → the project's current value is used.
    allotmentPct: { type: Number, default: null, min: 0, max: 100 },
    downPayment: { type: Number, default: 0, min: 0 },
    // The live schedule: updated when a prepayment reshapes it.
    tenureMonths: { type: Number, default: 0, min: 0 },
    emiAmount: { type: Number, default: 0, min: 0 },
    revision: { type: Number, default: 0, min: 0 },
    bookedOn: { type: Date, required: true },

    status: { type: String, enum: Object.values(BOOKING_STATUSES), default: BOOKING_STATUSES.ACTIVE, index: true },
    // Kept in step with PlotPayment inside the same transaction as each receipt.
    paidTotal: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '' },

    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null }, // the admin
    // The first payment of a PENDING booking (a cheque), held here until the
    // admin approves it; approving records it as the receipt. Kept afterwards
    // as the record of what was cleared.
    pendingPayment: {
      type: new mongoose.Schema(
        {
          amount: { type: Number, required: true, min: 0 },
          paidOn: { type: Date, required: true },
          mode: { type: String, default: '' },
          reference: { type: String, default: '' },
          ratingPct: { type: Number, default: 100, min: 0, max: 100 }
        },
        { _id: false }
      ),
      default: null
    },
    approval: {
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null }
    },
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
