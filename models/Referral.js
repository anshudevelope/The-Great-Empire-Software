const mongoose = require('mongoose');
const { REFERRAL_STATUSES, TIERS, PAYMENT_MODES } = require('../config/constants');

/**
 * A referral — the record of one member being paid for by their sponsor.
 *
 * Flow:
 *   1. Sponsor (B) pays for the new associate (C) offline.
 *   2. Admin registers C, choosing B as sponsor and recording the payment.
 *      That registration raises this referral, which backs the invoice.
 *   3. The tree slot is filled either by the admin right there (optional leg),
 *      or later by B from their portal — B picks the parent inside their own
 *      tree and the leg.
 *
 * Status tracks placement: 'unused' until C is in the tree, then 'used'.
 */
const referralSchema = new mongoose.Schema(
  {
    referralNo: { type: String, required: true, unique: true, uppercase: true, trim: true },

    // The shared receipt. Both the admin and the sponsor see this same record
    // in their dashboards.
    invoiceNo: { type: String, required: true, unique: true, uppercase: true, trim: true },

    // Money the SPONSOR PAID TO THE COMPANY for this member, collected offline.
    // Recorded only — nothing computes a reward, commission or payout from it.
    amountPaid: { type: Number, required: true, min: 0 },

    // --- Payment detail: all optional -------------------------------------
    paymentMode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
    paymentRef: { type: String, default: '', trim: true }, // UPI txn id, cheque no, bank ref

    // When the money actually changed hands — separate from createdAt, because
    // payment day and registration day often differ.
    receivedOn: { type: Date, default: Date.now },

    // Who took the money, with a name/code snapshot so the receipt keeps its
    // wording if that person is later renamed or removed.
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    receivedByName: { type: String, default: '' },
    receivedByCode: { type: String, default: '' },

    // Snapshot of the member's tier — an invoice is a historical document.
    tier: { type: String, enum: Object.values(TIERS), required: true },

    // The referred member.
    // No `index: true` here on purpose — the partial unique index declared
    // below covers it. Declaring both makes Mongoose silently DROP the partial
    // one, which would leave one-referral-per-member unenforced.
    member: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },
    memberCode: { type: String, required: true },
    memberName: { type: String, default: '' },

    // The sponsor — who paid for the member and may place them in their tree.
    issuedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    issuedToCode: { type: String, required: true },

    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    status: {
      type: String,
      enum: Object.values(REFERRAL_STATUSES),
      default: REFERRAL_STATUSES.UNUSED,
      index: true
    },

    // Set once the member has actually been placed in the tree.
    usedAt: { type: Date, default: null },
    // 'admin' when the admin placed the member, 'sponsor' when the sponsor did.
    placedBy: { type: String, enum: ['admin', 'sponsor', null], default: null },
    placedUnderCode: { type: String, default: null },
    placedPosition: { type: String, default: null },

    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    // Dashboard notification state for the sponsor.
    readAt: { type: Date, default: null },

    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

referralSchema.index({ issuedTo: 1, status: 1 });
referralSchema.index({ createdAt: -1 });

// A member can only be referred once — a second live referral for the same
// person would let two sponsors both claim them. Cancelled ones are excluded so
// a mistake can be cancelled and re-raised.
referralSchema.index(
  { member: 1 },
  {
    unique: true,
    partialFilterExpression: {
      member: { $type: 'objectId' },
      status: { $in: ['unused', 'used'] }
    }
  }
);

module.exports = mongoose.model('Referral', referralSchema);
