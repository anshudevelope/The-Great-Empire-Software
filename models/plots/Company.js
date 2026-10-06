const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { RECORD_STATUSES } = require('../../config/plotConfig');
const { mediaSchema } = require('./shared');

// The legal entity a project is sold under. T2 may run several.
const companySchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    contactNumber: { type: String, required: true, trim: true },
    country: { type: String, default: 'India', trim: true },
    state: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    pinCode: { type: String, required: true, trim: true },
    logo: { type: mediaSchema, default: () => ({}) },
    status: { type: String, enum: Object.values(RECORD_STATUSES), default: RECORD_STATUSES.ACTIVE }
  },
  { timestamps: true }
);

companySchema.index({ name: 1 });

module.exports = bindModel('PropertyCompany', companySchema, { only: BUSINESSES.T2 });
