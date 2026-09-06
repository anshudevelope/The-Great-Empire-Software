const mongoose = require('mongoose');
const { REFERRAL_STATUSES, TIERS, PAYMENT_MODES } = require('../config/constants');

/**
 * A referral voucher — the gate for every new member.
 *
 * Flow: an associate contacts the admin offline and pays. The admin generates
 * a voucher issued TO that associate. The associate later redeems it from
 * their dashboard (Phase 3) to register a new member.
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

    tier: { type: String, enum: Object.values(TIERS), required: true },

    // The associate this voucher belongs to. Becomes the SPONSOR of whoever
    // is registered with it. Only this associate may redeem it.
    issuedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    issuedToCode: { type: String, required: true },

    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    status: {
      type: String,
      enum: Object.values(REFERRAL_STATUSES),
      default: REFERRAL_STATUSES.UNUSED,
      index: true
    },

    // Set on redemption (Phase 3).
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    usedByCode: { type: String, default: null },
    usedAt: { type: Date, default: null },

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
