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

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------
const COMMISSION_TYPES = {
  DIRECT: 'direct',     // 10% to the sponsor, one level, on the member's amountPaid
  MATCHING: 'matching', // 5% of min(carryLeft, carryRight) at every ancestor
  REVERSAL: 'reversal'  // negative row undoing an earlier one; never an edit
};

// Rates live here, never inline. Changing a rate must NOT retroactively alter
// historical rows — which is why every ledger entry freezes the rate it used
// into basis.rate. This table is only ever read for NEW rows.
const COMMISSION_RATES = {
  [TIERS.ONE]: { direct: 0.10, matching: 0.05 },
  [TIERS.TWO]: { direct: 0, matching: 0 } // Tier II generates no volume yet
};

// Which leg a member sits on maps to the carry/volume field of an ancestor.
const CARRY_FIELD = { [POSITIONS.LEFT]: 'carryLeft', [POSITIONS.RIGHT]: 'carryRight' };
const VOLUME_FIELD = { [POSITIONS.LEFT]: 'totalLeftVolume', [POSITIONS.RIGHT]: 'totalRightVolume' };

// ---------------------------------------------------------------------------
// Payout / closing
// ---------------------------------------------------------------------------
// A batch is built as a DRAFT (nothing committed, fully discardable), then
// FINALIZED in one guarded step that stamps the ledger and zeroes the members.
// CANCELLED undoes a finalized batch from the snapshots stored on its lines.
const PAYOUT_STATUSES = {
  DRAFT: 'draft',
  FINALIZED: 'finalized',
  CANCELLED: 'cancelled'
};

const PAYOUT = {
  SEQUENCE: 'payoutNo',
  PREFIX: 'PAY-',
  PAD: 6 // PAY-000123
};

// Runtime settings, stored in the Setting collection rather than
// data/company.json: rates must be changeable without a redeploy, and every
// change has to be auditable. These are only the fallbacks used when a key has
// never been written.
//
// Rates here are read ONCE per batch and frozen onto it — changing a value
// never moves a payout that has already been generated.
const SETTING_KEYS = {
  ADMIN_CHARGE_PCT: 'payout.adminChargePct',
  SECONDARY_CHARGE_PCT: 'payout.secondaryChargePct',
  SECONDARY_CHARGE_LABEL: 'payout.secondaryChargeLabel',
  FLUSH_CARRY_ON_CLOSE: 'payout.flushCarryOnClose',
  MINIMUM_PAYABLE: 'payout.minimumPayable',
  INCLUDE_ZERO_INCOME: 'payout.includeZeroIncomeMembers'
};

const SETTING_DEFAULTS = {
  [SETTING_KEYS.ADMIN_CHARGE_PCT]: 0.05,
  [SETTING_KEYS.SECONDARY_CHARGE_PCT]: 0.05,
  [SETTING_KEYS.SECONDARY_CHARGE_LABEL]: 'TDS',
  // OFF: unmatched carry survives a closing and pairs up in a later period,
  // exactly like volume that never got matched within one period. Only the
  // MONEY resets at a closing; the business does not.
  //
  // Kept as a setting rather than removed, because the opposite behaviour is
  // common in binary plans and the client may still want it. Turning it on is
  // one-way in practice: flushed carry is a running balance that depends on the
  // order members were placed in, so it cannot be reconstructed from the ledger.
  // See PAYOUT-ENGINE-PLAN.md §0.1.
  [SETTING_KEYS.FLUSH_CARRY_ON_CLOSE]: false,
  [SETTING_KEYS.MINIMUM_PAYABLE]: 0,
  [SETTING_KEYS.INCLUDE_ZERO_INCOME]: false
};

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

// How many accounts may share one phone number. Lets one person run a few IDs
// from a single number. Email stays unique — it is the login identity.
const MAX_ASSOCIATES_PER_PHONE = 3;

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
//   carryLeft/carryRight                 → maintained by commissionService via
//                                          atomic $inc only. A whitelisted write
//                                          here would let carry be set by hand,
//                                          which mints matching income.
//   totalLeftVolume/totalRightVolume/directIncome/matchingIncome
//                 → denormalised caches of the ledger; rebuilt by
//                   scripts/verifyCommissions.js, never assigned by a request
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
  COMMISSION_TYPES,
  COMMISSION_RATES,
  CARRY_FIELD,
  VOLUME_FIELD,
  PAYOUT_STATUSES,
  PAYOUT,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  MEMBER_CODE,
  TREE_STATUSES,
  REFERRAL_STATUSES,
  REFERRAL,
  INVOICE,
  PAYMENT_MODES,
  MAX_ASSOCIATES_PER_PHONE,
  ADMIN_UPDATABLE_FIELDS,
  SELF_UPDATABLE_FIELDS,
  pickAllowedFields
};
