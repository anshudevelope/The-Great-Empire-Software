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

        // System & Binary Structure
        role: { type: String, enum: ['associate', 'admin'], default: 'associate' },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending'
        },
        sponsorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
        tier: { type: String, enum: ['Tier I', 'Tier II'], default: 'Tier I' },

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