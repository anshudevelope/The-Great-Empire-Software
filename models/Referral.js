const mongoose = require('mongoose');
const { bindModel } = require('../utils/businessContext');
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
    //
    // This is the BUSINESS amount: it backs the receipt, and it is what counts
    // toward each upline's leg volume. It is not validated against the tier's
    // nominal price.
    amountPaid: { type: Number, required: true, min: 0 },

    // How much of `amountPaid` earns commission, as a percentage.
    //
    // At 70 on a 1,00,000 registration, every commission — the 10% direct and
    // the volume that feeds binary matching — is computed on 70,000. The other
    // 30,000 is not lost: it still counts as business, so leg volume and the
    // receipt both show the full 1,00,000. Only the earning half is reduced.
    //
    // Defaults to 100 so a referral without one behaves exactly as before; the
    // engine also reads it as `rating ?? 100`, so records written before this
    // field existed need no migration.
    rating: { type: Number, default: 100, min: 0, max: 100 },

    // amountPaid × rating, resolved and frozen at the moment the payment is
    // recorded. Derivable in principle, stored in practice:
    //
    //   - rounding happens once, here, so nothing downstream can re-derive it
    //     to a different paisa;
    //   - a member who is never placed has no ledger row, so this is the only
    //     place the commissionable figure would otherwise exist;
    //   - reports can sum it directly instead of recomputing per row.
    //
    // Derived by the hook below rather than by any caller, so a direct
    // Referral.create() — the seed scripts do exactly that — cannot leave it
    // at zero and silently wipe out the commission.
    commissionBase: { type: Number, default: 0, min: 0 },

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

// ---------------------------------------------------------------------------
// commissionBase is always amountPaid × rating — never a caller's arithmetic.
//
// A hook rather than a helper the callers remember to use: every create and
// every save passes through here, including the seed scripts that build
// referrals by hand. Rounding happens once, at this single point.
//
// It does NOT fire on updateOne/findOneAndUpdate, which is why the payment edit
// path assigns onto the document and calls save().
// ---------------------------------------------------------------------------
referralSchema.pre('validate', function setCommissionBase() {
  const rating = this.rating ?? 100;
  this.commissionBase = Math.round((this.amountPaid || 0) * (rating / 100) * 100) / 100;
});

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

module.exports = bindModel('Referral', referralSchema);
