const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { COMMISSION_TYPES, POSITIONS } = require('../../config/constants');

/**
 * Plot commission ledger — its own collection, separate from the registration
 * ledger. Same rules: append-only, a mistake is undone by a REVERSAL row
 * pointing at the original, and every row freezes the inputs it was computed
 * from so it still explains itself years later.
 */
const plotCommissionSchema = new mongoose.Schema(
  {
    // Makes every payment's commission run safe to repeat: a duplicate insert
    // means "already paid", not an error.
    idempotencyKey: { type: String, required: true, unique: true },
    beneficiary: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    beneficiaryCode: { type: String, required: true },
    type: { type: String, enum: Object.values(COMMISSION_TYPES), required: true },
    amount: { type: Number, required: true }, // negative on reversals

    // What produced it: the associate the sale is credited to, and the payment.
    sourceAssociate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },
    sourceAssociateCode: { type: String, required: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotBooking', required: true, index: true },
    bookingCode: { type: String, required: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotPayment', default: null },

    basis: {
      rate: { type: Number, required: true },
      base: { type: Number, required: true },
      rating: { type: Number, default: null }, // direct rows only
      legSide: { type: String, enum: [...Object.values(POSITIONS), null], default: null },
      carryLeftBefore: { type: Number, default: null },
      carryRightBefore: { type: Number, default: null },
      carryLeftAfter: { type: Number, default: null },
      carryRightAfter: { type: Number, default: null },
      depthFromSource: { type: Number, default: null }
    },

    // null = earned, not yet paid. Set when a plot payout is finalized.
    payout: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotPayout', default: null },
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotCommission', default: null },
    note: { type: String, default: '' }
  },
  { timestamps: true }
);

plotCommissionSchema.index({ payout: 1, beneficiary: 1 });

module.exports = bindModel('PlotCommission', plotCommissionSchema, { only: BUSINESSES.T2 });
