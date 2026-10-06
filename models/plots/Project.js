const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { RECORD_STATUSES, PROJECT_STATUSES } = require('../../config/plotConfig');
const { mediaSchema } = require('./shared');

/**
 * A site being sold, e.g. "Samriddhi Residency". Besides what the admin needs to
 * sell plots, it carries everything a public project page will show — location,
 * marketing copy, legal approvals and media — so the website can be built on it
 * later without another migration.
 */
const projectSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyCompany', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // URL-safe name for the future public page. Unique per business.
    slug: { type: String, required: true, unique: true },
    projectStatus: {
      type: String,
      enum: Object.values(PROJECT_STATUSES),
      default: PROJECT_STATUSES.ONGOING
    },
    launchDate: { type: Date, default: null },
    possessionDate: { type: Date, default: null },
    // Share of the price to be paid before a plot counts as allotted. Stored
    // and shown; no rule reads it yet.
    allotmentPct: { type: Number, default: 0, min: 0, max: 100 },
    // Shown on the public website.
    visible: { type: Boolean, default: true },
    status: { type: String, enum: Object.values(RECORD_STATUSES), default: RECORD_STATUSES.ACTIVE },

    location: {
      address: { type: String, default: '', trim: true },
      city: { type: String, default: '', trim: true },
      state: { type: String, default: '', trim: true },
      pinCode: { type: String, default: '', trim: true },
      mapsUrl: { type: String, default: '', trim: true },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      landmarks: { type: [String], default: [] }
    },

    marketing: {
      shortDescription: { type: String, default: '', trim: true },
      description: { type: String, default: '' },
      amenities: { type: [String], default: [] },
      highlights: { type: [String], default: [] }
    },

    legal: {
      reraNumber: { type: String, default: '', trim: true },
      approvals: {
        type: [
          new mongoose.Schema(
            { authority: { type: String, trim: true }, number: { type: String, trim: true } },
            { _id: false }
          )
        ],
        default: []
      },
      registryDetails: { type: String, default: '' }
    },

    media: {
      cover: { type: mediaSchema, default: () => ({}) },
      layoutMap: { type: mediaSchema, default: () => ({}) },
      brochure: { type: mediaSchema, default: () => ({}) },
      gallery: { type: [mediaSchema], default: [] },
      videoUrl: { type: String, default: '', trim: true }
    }
  },
  { timestamps: true }
);

module.exports = bindModel('PropertyProject', projectSchema, { only: BUSINESSES.T2 });
