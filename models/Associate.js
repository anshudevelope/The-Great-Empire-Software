const mongoose = require('mongoose');
const { ROLES, STATUSES, TIERS, POSITIONS } = require('../config/constants');

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

        // Forces a reset at first login. New members are created with a
        // system-generated temporary password handed to their sponsor, so the
        // sponsor must never retain working credentials for their downline.
        mustChangePassword: { type: Boolean, default: true },

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
        // Sponsor tree (referral) — decides who gets referral credit
        // ------------------------------------------------------------------
        // Differs from parentId whenever spillover moved the member down a leg.
        sponsorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        sponsorCode: { type: String, default: null },  // denormalised for fast reports
        directCount: { type: Number, default: 0 },

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
associateSchema.index({ sponsorId: 1 });   // "My Directs" / referral reports
associateSchema.index({ parentId: 1 });
associateSchema.index({ sponsorCode: 1 });
associateSchema.index({ status: 1 });
associateSchema.index({ role: 1 });
associateSchema.index({ depth: 1 });
associateSchema.index({ createdAt: -1 });

// ---------------------------------------------------------------------------
// Safety net: never serialise the password hash.
//
// select:false covers queries, but a document just built in memory (e.g. the
// freshly created associate returned from register) still carries it. This
// transform catches that path too.
// ---------------------------------------------------------------------------
const stripSensitive = (doc, ret) => {
    delete ret.password;
    return ret;
};
associateSchema.set('toJSON', { transform: stripSensitive });
associateSchema.set('toObject', { transform: stripSensitive });

// Convenience virtuals
associateSchema.virtual('isRoot').get(function () {
    return this.role === ROLES.ASSOCIATE && this.parentId === null;
});

module.exports = mongoose.model('Associate', associateSchema);
