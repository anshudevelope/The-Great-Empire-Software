const mongoose = require('mongoose');

// Building blocks shared by the T2 property / plot-sales models.

/**
 * An image or file. Phase 2 stores a URL typed in by the admin; publicId stays
 * null until uploads move to Cloudinary, which then fills both — no schema
 * change needed.
 */
const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, default: '' },
    publicId: { type: String, default: null }
  },
  { _id: false }
);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = { mediaSchema, round2 };
