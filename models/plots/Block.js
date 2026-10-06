const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { RECORD_STATUSES, RATE_UNITS } = require('../../config/plotConfig');

/**
 * A batch of identical plots inside a project. Creating one generates its plots
 * (see blockService), each copying the size and price below — which is why
 * geometry and rate are frozen once the block exists: a plot's price is edited
 * on the plot. Booked / available counts are always counted from the plots,
 * never stored, so they cannot drift.
 */
const blockSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyCompany', required: true },
    name: { type: String, required: true, trim: true },
    plotWidth: { type: Number, required: true, min: 0 }, // ft
    plotLength: { type: Number, required: true, min: 0 }, // ft
    plotSize: { type: Number, required: true, min: 0 }, // sq.ft = width × length
    rate: { type: Number, required: true, min: 0 },
    rateUnit: { type: String, enum: Object.values(RATE_UNITS), required: true },
    plotCost: { type: Number, required: true, min: 0 }, // price of one plot
    plotCount: { type: Number, required: true, min: 0 },
    startSerial: { type: Number, default: 1, min: 1 },
    // The next serial "add plots" continues from.
    nextSerial: { type: Number, required: true, min: 1 },
    remark: { type: String, default: '', trim: true },
    status: { type: String, enum: Object.values(RECORD_STATUSES), default: RECORD_STATUSES.ACTIVE }
  },
  { timestamps: true }
);

blockSchema.index({ project: 1, name: 1 }, { unique: true });

module.exports = bindModel('PropertyBlock', blockSchema, { only: BUSINESSES.T2 });
