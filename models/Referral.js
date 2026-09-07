const mongoose = require('mongoose');
const { REFERRAL_STATUSES, TIERS, PAYMENT_MODES } = require('../config/constants');

/**
 * A referral — the record of one member being paid for by another.
 *
 * Flow:
 *   1. Admin registers the new associate (C), usually with no tree placement.
 *   2. Existing associate (B) pays for C offline.
 *   3. Admin raises a referral linking C to sponsor B, recording the payment.
 *   4. The tree slot is filled either by the admin there and then, or later by
 *      B from their dashboard using the referral number + PIN.
 *
 * Note what redeeming does NOT do any more: it never creates a member. C
 * already exists from step 1, so redemption only assigns the sponsor and puts
 * C into the binary tree.
 *
 * Because the voucher is bound to `issuedTo`, the sponsor of the new member is
 * derived, never typed — which is what removes the sponsor field from the
 * registration form entirely.
 */
const referralSchema = new mongoose.Schema(
  {
    referralNo: { type: String, required: true, unique: true, uppercase: true, trim: true },

    // The shared receipt. Both the admin and the issued-to associate see this
    // same record in their dashboards.
    invoiceNo: { type: String, required: true, unique: true, uppercase: true, trim: true },

    // The PIN is a bearer credential: referralNo + PIN is enough to create a
    // member. So it is hashed like a password, select:false like a password,
    // and shown exactly once — at generation.
    pinHash: { type: String, required: true, select: false },

    // Last two digits only, so support can confirm "the one ending 02" without
    // the stored value ever being usable.
    pinLast2: { type: String, required: true },

    // Money the ASSOCIATE PAID TO THE COMPANY for this referral, collected
    // offline. It is recorded only — nothing computes a reward, commission or
    // payout from it. Named `amountPaid` rather than `amount` so the direction
    // of the money can't be misread later.
    amountPaid: { type: Number, required: true, min: 0 },

    // --- Payment detail: all optional -------------------------------------
    // The voucher is often issued before the payment record is reconciled, so
    // none of this blocks generation. Without it, though, a later dispute
    // ("I paid by UPI on the 4th") has nothing to check against.
    paymentMode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
    paymentRef: { type: String, default: '', trim: true }, // UPI txn id, cheque no, bank ref

    // When the money actually changed hands — deliberately separate from
    // createdAt, because an associate may pay on Monday and the admin may
    // generate the voucher on Wednesday. The books care about the former.
    receivedOn: { type: Date, default: Date.now },

    // Who took the money. Optional, and a reference so it can be picked from a
    // searchable list rather than typed.
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    // Snapshot at time of receipt: an invoice is a historical document and must
    // not change its wording if that person is later renamed or removed.
    receivedByName: { type: String, default: '' },
    receivedByCode: { type: String, default: '' },

    // Snapshot of the referred member's tier at the time of the transaction —
    // an invoice is a historical document and must not shift if anything on the
    // member record changes later.
    tier: { type: String, enum: Object.values(TIERS), required: true },

    // ---------------------------------------------------------------------
    // The referred member — created BEFORE the referral, not by it.
    //
    // Admin registers the associate first (usually unplaced), then raises a
    // referral that links that member to whoever paid for them. Redeeming no
    // longer creates anybody; it only places this member in the tree.
    // ---------------------------------------------------------------------
    // No `index: true` here on purpose — the partial unique index declared
    // below covers it. Declaring both makes Mongoose silently DROP the partial
    // one, which would leave one-referral-per-member unenforced.
    member: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },
    memberCode: { type: String, required: true },
    memberName: { type: String, default: '' },

    // The sponsor (referrer) — the existing associate who paid for the member
    // above and becomes their sponsor. Only they may redeem this referral.
    issuedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    issuedToCode: { type: String, required: true },       // their TRG####
    issuedToSponsorCode: { type: String, default: null }, // their SPN####

    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    status: {
      type: String,
      enum: Object.values(REFERRAL_STATUSES),
      default: REFERRAL_STATUSES.UNUSED,
      index: true
    },

    // Set once the member has actually been placed in the tree.
    usedAt: { type: Date, default: null },
    // 'admin' when the admin placed the member at referral time, 'sponsor' when
    // the referrer did it themselves with the PIN.
    placedBy: { type: String, enum: ['admin', 'sponsor', null], default: null },
    placedUnderCode: { type: String, default: null },
    placedPosition: { type: String, default: null },

    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    // Brute-force protection on the PIN.
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    // Dashboard notification state for the receiving associate.
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
  { unique: true, partialFilterExpression: { status: { $in: ['unused', 'used'] } } }
);

referralSchema.virtual('isLocked').get(function () {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
});

// Never serialise the PIN hash, even from a document built in memory.
const stripSensitive = (doc, ret) => {
  delete ret.pinHash;
  return ret;
};
referralSchema.set('toJSON', { transform: stripSensitive, virtuals: true });
referralSchema.set('toObject', { transform: stripSensitive, virtuals: true });

module.exports = mongoose.model('Referral', referralSchema);
