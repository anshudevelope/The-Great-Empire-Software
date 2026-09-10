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
  PREFIX: 'TGE',
  PAD: 4 // TGE0001 … TGE9999, then widens naturally to TGE10000
};

// ---------------------------------------------------------------------------
// Tree placement
// ---------------------------------------------------------------------------
// Placement is optional at creation: an associate exists as a record long
// before they occupy a node. Without an explicit marker, "unplaced" and "root"
// are indistinguishable — both have parentId null — so the single-root rule
// would have nothing to check.
const TREE_STATUSES = {
  UNPLACED: 'unplaced', // created, listed, but not in the tree yet
  ROOT: 'root',         // the one and only tree root
  PLACED: 'placed'      // sits under a parent
};

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------
// Raised automatically when the admin registers an associate under a sponsor.
// It records the payment (and backs the invoice) and tracks placement:
// 'unused' = not in the tree yet, 'used' = placed.
const REFERRAL_STATUSES = {
  UNUSED: 'unused',
  USED: 'used',
  CANCELLED: 'cancelled'
};

const REFERRAL = {
  SEQUENCE: 'referralNo',
  PREFIX: 'REF-',
  PAD: 6 // REF-000123
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
//   password      → change-password endpoint, or the admin's own guarded path
//   memberCode    → immutable public identity
//   tier          → fixed for life at registration
//   role          → no self-service role changes
//   sponsorId     → set once at registration
//   ancestors/depth/leftChild/rightChild → maintained by the tree engine
//   directCount   → maintained by the system
// Placement (parentId + position) is handled by its own guarded code path and
// is not part of any whitelist.

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
  TREE_STATUSES,
  REFERRAL_STATUSES,
  REFERRAL,
  INVOICE,
  PAYMENT_MODES,
  ADMIN_UPDATABLE_FIELDS,
  SELF_UPDATABLE_FIELDS,
  pickAllowedFields
};
