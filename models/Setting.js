const mongoose = require('mongoose');
const { SETTING_DEFAULTS } = require('../config/constants');

/**
 * Runtime configuration — rates, toggles, thresholds.
 *
 * Deliberately NOT data/company.json. That file is read once at boot and holds
 * content (branding, bank block, invoice footers); this holds numbers that
 * change the money. Payout rates must be editable without a redeploy, and every
 * change has to leave an audit trail naming who made it.
 *
 * Values are read at the moment a payout batch is generated and then FROZEN
 * onto that batch. Changing a rate here never moves a payout that already
 * exists — same principle as basis.rate on a commission ledger row.
 */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },

    // Mixed because settings are genuinely heterogeneous: 0.05, true, 'TDS'.
    // Callers go through Setting.get(), which applies the default and the type.
    value: { type: mongoose.Schema.Types.Mixed, required: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    updatedByCode: { type: String, default: null }
  },
  { timestamps: true }
);

/**
 * One setting, falling back to the compiled-in default.
 *
 * A missing key is normal, not an error: nothing seeds the collection on a
 * fresh install, and a default that only exists in the database is a default
 * that can be lost.
 */
settingSchema.statics.get = async function (key) {
  const row = await this.findOne({ key }).lean();
  return row ? row.value : SETTING_DEFAULTS[key];
};

/**
 * Every payout setting in one read, defaults filled in.
 *
 * Used by the payout engine so a batch takes a single consistent snapshot
 * rather than six separate reads that could interleave with an edit.
 */
settingSchema.statics.getAll = async function () {
  const rows = await this.find({ key: { $in: Object.keys(SETTING_DEFAULTS) } }).lean();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...SETTING_DEFAULTS, ...stored };
};

settingSchema.statics.put = function (key, value, actor = null) {
  return this.findOneAndUpdate(
    { key },
    {
      value,
      updatedBy: actor?._id ?? null,
      updatedByCode: actor?.memberCode ?? null
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('Setting', settingSchema);
