const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { RECORD_STATUSES } = require('../../config/plotConfig');
const { mediaSchema } = require('./shared');

/**
 * A plot buyer. Managed by the admin, never placed in the tree, no login —
 * the associate a sale is credited to is recorded on the booking instead.
 */
const clientSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, default: '', trim: true },
    fullName: { type: String, required: true, trim: true },
    guardianName: { type: String, default: '', trim: true },
    gender: { type: String, enum: ['Male', 'Female', 'Other', ''], default: '' },
    dob: { type: Date, default: null },
    // The lookup key at Sell time, so one client per mobile.
    mobile: { type: String, required: true, unique: true, trim: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    address: { type: String, default: '', trim: true },
    city: { type: String, default: '', trim: true },
    state: { type: String, default: '', trim: true },
    pinCode: { type: String, default: '', trim: true },
    idProof: {
      type: { type: String, default: '', trim: true },
      number: { type: String, default: '', trim: true },
      file: { type: mediaSchema, default: () => ({}) }
    },
    notes: { type: String, default: '' },
    status: { type: String, enum: Object.values(RECORD_STATUSES), default: RECORD_STATUSES.ACTIVE }
  },
  { timestamps: true }
);

module.exports = bindModel('PlotClient', clientSchema, { only: BUSINESSES.T2 });
