const mongoose = require('mongoose');

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
        password: { type: String, required: true },
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

        // System Details
        role: { type: String, enum: ['associate', 'admin'], default: 'associate' },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending'
        },
        tier: { type: String, enum: ['Tier I', 'Tier II'], default: 'Tier I' },

        // Scalable Binary Tree Architecture
        sponsorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null }, // Direct Referral Sponsor
        parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },   // Direct Node Parent in Tree
        position: { type: String, enum: ['Left', 'Right', null], default: null },              // Branch placement under Parent

        // Direct Children References (Guarantees binary limit of max 2 direct children)
        leftChild: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        rightChild: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },

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

module.exports = mongoose.model('Associate', associateSchema);