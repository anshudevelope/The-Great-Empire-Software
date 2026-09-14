const mongoose = require('mongoose');
const { ROLES, STATUSES, TIERS, POSITIONS, TREE_STATUSES } = require('../config/constants');

const associateSchema = new mongoose.Schema(
    {
        // Personal Details
        title: { type: String, enum: ['Mr.', 'Mrs.', 'Ms.', 'Dr.'], required: true },
        fullName: { type: String, required: true, trim: true },
        fatherOrHusbandName: { type: String, default: '', trim: true },
        maritalStatus: { type: String, enum: ['Single', 'Married', 'Divorced', 'Widowed'], default: 'Single' },
        gender: { type: String, enum: ['Male', 'Female', 'Other'], required: true },
        phone: { type: String, required: true, unique: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },

        // select:false keeps the hash out of every ordinary query. Login must
        // opt back in explicitly with .select('+password').
        password: { type: String, required: true, select: false },

        // AES-GCM copy of the same password (utils/secretBox) so the admin panel
        // can display it. Login never reads this — it verifies the hash above.
        // Null for accounts created before this existed; the admin sets a new
        // password from Edit to populate it.
        passwordEnc: { type: String, default: null, select: false },

        dob: { type: Date },
        age: { type: Number },
        address: { type: String, default: '' },
        city: { type: String, default: '' },
        country: { type: String, required: true, default: 'India' },
        state: { type: String, required: true, default: 'Uttar Pradesh' },
        pinCode: { type: String, default: '' },

        // Nominee Details
        nomineeName: { type: String, default: '' },
        nomineeRelation: { type: String, default: '' },
        nomineeAge: { type: Number },

        // ------------------------------------------------------------------
        // Identity
        // ------------------------------------------------------------------
        // Public, human-typeable code: TRG0001, TRG0042 …
        // Associates only. Admin accounts live in this same collection but sit
        // OUTSIDE the tree and carry no member code, hence no default: null —
        // an explicit null would collide on the unique index (see below).
        memberCode: { type: String, uppercase: true, trim: true },

        // System Details
        role: { type: String, enum: Object.values(ROLES), default: ROLES.ASSOCIATE },
        status: {
            type: String,
            enum: Object.values(STATUSES),
            default: STATUSES.PENDING
        },

        // Tier I = Insurance, Tier II = Plots.
        // One shared binary tree — the tier is only an attribute, never a
        // second tree. Fixed for life: set by the joining voucher, immutable
        // afterwards, and excluded from every update whitelist.
        tier: {
            type: String,
            enum: Object.values(TIERS),
            immutable: true,
            required: function () { return this.role === ROLES.ASSOCIATE; }
        },

        // ------------------------------------------------------------------
        // Binary tree (placement) — decides where business volume flows
        // ------------------------------------------------------------------
        // Placement is OPTIONAL at creation. An associate is a real record from
        // the moment they are created; occupying a tree node happens later,
        // either when the admin places them or when their sponsor redeems a
        // referral. Unplaced members appear in listings but not in the tree.
        treeStatus: {
            type: String,
            enum: Object.values(TREE_STATUSES),
            default: TREE_STATUSES.UNPLACED,
            index: true
        },

        parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        position: { type: String, enum: [...Object.values(POSITIONS), null], default: null },

        // Denormalised child pointers: two fields structurally guarantee the
        // binary limit of max 2 children.
        leftChild: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        rightChild: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },

        // Materialised path: [root, …, direct parent]. This is what makes
        // downline reports and the RBAC ownership check single indexed
        // queries instead of recursive traversals:
        //   Associate.find({ ancestors: X })              → entire downline
        //   Associate.exists({ _id: Y, ancestors: X })    → is Y under X?
        // Must be re-pathed for the whole subtree whenever a node is moved.
        ancestors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Associate' }],
        depth: { type: Number, default: 0 },

        // ------------------------------------------------------------------
        // Referral credit — two roles, kept apart on purpose
        // ------------------------------------------------------------------
        // Referred by: who paid for / enrolled this member. Set by the admin at
        // registration (or Generate Referral) and never changed afterwards — it
        // is a payment fact. Their referral and invoice name the same person,
        // and they are the one who places the member.
        referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        referredByCode: { type: String, default: null },

        // Sponsor: who gets the referral credit — My Directs, the sponsor tree,
        // directCount, and any future referral income. Starts as referredBy; the
        // referrer may pass it once, while placing, to themselves or someone in
        // their own tree. After that only the admin can change it. Independent
        // of tree position (parentId). memberCode doubles as the sponsor's ID.
        sponsorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        // Denormalised member code of that sponsor, for fast reports and display.
        sponsorMemberCode: { type: String, default: null },
        directCount: { type: Number, default: 0 },

        // ------------------------------------------------------------------
        // Commission — carry and denormalised totals
        // ------------------------------------------------------------------
        // Unmatched business volume per leg, in rupees. Matching pays 5% of
        // min(carryLeft, carryRight) and deducts that amount from BOTH sides;
        // whatever is left over stays here and waits for a counterpart. Never
        // flushed, never expired.
        //
        // Maintained ONLY by commissionService, and only through atomic $inc —
        // read-then-assign loses updates when two members are placed on
        // opposite legs at the same instant. Excluded from every update
        // whitelist: a hand-set carry mints matching income out of nothing.
        carryLeft: { type: Number, default: 0, min: 0 },
        carryRight: { type: Number, default: 0, min: 0 },

        // Lifetime figures, denormalised so a dashboard is one document read
        // rather than an aggregation across the whole ledger.
        //
        // These are a CACHE. CommissionLedger is the source of truth —
        // scripts/verifyCommissions.js recomputes these from it and reports
        // drift, the same way verifyTree.js does for ancestors/depth.
        totalLeftVolume: { type: Number, default: 0 },
        totalRightVolume: { type: Number, default: 0 },
        directIncome: { type: Number, default: 0 },
        matchingIncome: { type: Number, default: 0 },

        // Media Uploads
        profileImage: {
            url: { type: String, default: '' },
            public_id: { type: String, default: '' }
        },
        documents: [
            {
                docType: { type: String, required: true },
                url: { type: String, required: true },
                public_id: { type: String, required: true }
            }
        ]
    },
    { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Unique member codes, but only across documents that actually have one.
// A plain `unique: true` would reject the second admin (both null); `sparse`
// wouldn't help either, since an explicit null still gets indexed. A partial
// index on "is a string" is the version that behaves correctly.
associateSchema.index(
    { memberCode: 1 },
    { unique: true, partialFilterExpression: { memberCode: { $type: 'string' } } }
);

associateSchema.index({ ancestors: 1 });   // downline reports + ownership checks
associateSchema.index({ referredBy: 1 });  // "Place members" — who the caller referred
associateSchema.index({ sponsorId: 1 });   // "My Directs" / referral reports
associateSchema.index({ parentId: 1 });
associateSchema.index({ sponsorMemberCode: 1 });
associateSchema.index({ status: 1 });
associateSchema.index({ role: 1 });
associateSchema.index({ depth: 1 });
associateSchema.index({ createdAt: -1 });

// ---------------------------------------------------------------------------
// Safety net: never serialise the password hash or its encrypted copy.
//
// select:false covers queries, but a document just built in memory (e.g. the
// freshly created associate returned from register) still carries them. This
// transform catches that path too. Admin endpoints add a decrypted `password`
// explicitly, after serialising.
// ---------------------------------------------------------------------------
const stripSensitive = (doc, ret) => {
    delete ret.password;
    delete ret.passwordEnc;
    return ret;
};
associateSchema.set('toJSON', { transform: stripSensitive });
associateSchema.set('toObject', { transform: stripSensitive });

// Convenience virtuals
associateSchema.virtual('isRoot').get(function () {
    return this.treeStatus === TREE_STATUSES.ROOT;
});

associateSchema.virtual('isInTree').get(function () {
    return this.treeStatus !== TREE_STATUSES.UNPLACED;
});

module.exports = mongoose.model('Associate', associateSchema);
