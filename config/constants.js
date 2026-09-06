// Single source of truth for enums, labels and update whitelists.

const ROLES = { ADMIN: 'admin', ASSOCIATE: 'associate' };

const STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended'
};

const TIERS = { ONE: 'Tier I', TWO: 'Tier II' };

// Tier I = Insurance, Tier II = Plots. Kept here so no UI or query hardcodes
// the product name — tiers are one shared tree, the tier is only an attribute.
const TIER_LABELS = {
  [TIERS.ONE]: 'Insurance',
  [TIERS.TWO]: 'Plots'
};

const POSITIONS = { LEFT: 'Left', RIGHT: 'Right' };

const MEMBER_CODE = {
  SEQUENCE: 'memberCode',
  PREFIX: 'TRG',
  PAD: 4 // TRG0001 … TRG9999, then widens naturally to TRG10000
};

// ---------------------------------------------------------------------------
// Referral vouchers
// ---------------------------------------------------------------------------
// Admin issues a voucher TO an associate; that associate redeems it to add a
// new member. The voucher binds the sponsor, so the registration form never
// asks who referred the new member — it's derived.
const REFERRAL_STATUSES = {
  UNUSED: 'unused',
  USED: 'used',
  CANCELLED: 'cancelled'
  // Deliberately no 'expired' — vouchers do not expire.
};

const REFERRAL = {
  SEQUENCE: 'referralNo',
  PREFIX: 'REF-',
  PAD: 6, // REF-000123

  // The PIN is a bearer credential worth money: whoever holds referralNo + PIN
  // can create a member. Treated exactly like a password.
  PIN_LENGTH: 6,
  MAX_ATTEMPTS: 5,
  LOCK_MINUTES: 15
};

const INVOICE = {
  SEQUENCE: 'invoiceNo', // suffixed per year: invoiceNo:2026
  PREFIX: 'INV-',
  PAD: 6 // INV-2026-000123
};

// How the associate handed the money over. All payment detail is optional —
// admin often issues the voucher first and reconciles the payment record
// afterwards — but `amountPaid` itself is always required.
const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card', 'Other'];

// ---------------------------------------------------------------------------
// Update whitelists — never spread req.body into an update.
//
// Without these an authenticated associate could PATCH their own record with
// { role: 'admin' } or { tier: 'Tier II' } and escalate. Anything not listed
// here is silently dropped by pickAllowedFields().
// ---------------------------------------------------------------------------

// Fields an admin may edit on any associate.
const ADMIN_UPDATABLE_FIELDS = [
  'title', 'fullName', 'fatherOrHusbandName', 'maritalStatus', 'gender',
  'phone', 'email', 'dob', 'age',
  'address', 'city', 'country', 'state', 'pinCode',
  'nomineeName', 'nomineeRelation', 'nomineeAge',
  'status'
];

// Fields an associate may edit on their OWN profile. Deliberately excludes
// email/phone (login identity) and everything structural.
const SELF_UPDATABLE_FIELDS = [
  'fatherOrHusbandName', 'maritalStatus',
  'address', 'city', 'state', 'pinCode',
  'nomineeName', 'nomineeRelation', 'nomineeAge'
];

// Never updatable through a generic update, by anyone:
//   password      → dedicated change-password endpoint
//   memberCode    → immutable public identity
//   tier          → fixed for life by the joining voucher
//   role          → no self-service role changes
//   sponsorId/Code→ set once at registration
//   ancestors/depth/leftChild/rightChild → maintained by the tree engine
//   directCount / mustChangePassword     → maintained by the system
// Placement (parentId + position) is handled by its own guarded code path,
// admin-only, and is not part of any whitelist.

const pickAllowedFields = (source = {}, allowed = []) => {
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
};

module.exports = {
  ROLES,
  STATUSES,
  TIERS,
  TIER_LABELS,
  POSITIONS,
  MEMBER_CODE,
  REFERRAL_STATUSES,
  REFERRAL,
  INVOICE,
  PAYMENT_MODES,
  ADMIN_UPDATABLE_FIELDS,
  SELF_UPDATABLE_FIELDS,
  pickAllowedFields
};
