const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');

/**
 * One associate's plot business — a separate pool from registration.
 *
 * Kept in its own collection rather than as fields on Associate, so the plot
 * system never writes to a T1 model. Created on first use (upsert). Carry is
 * what matching pays on and only ever changes through atomic $inc / guarded
 * updates in the plot commission service.
 */
const plotNetworkSchema = new mongoose.Schema(
  {
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, unique: true },
    memberCode: { type: String, default: '' },
    carryLeft: { type: Number, default: 0 },
    carryRight: { type: Number, default: 0 },
    // Turnover from each leg (whole payment) and its commissionable share.
    totalLeftVolume: { type: Number, default: 0 },
    totalRightVolume: { type: Number, default: 0 },
    totalLeftRatedVolume: { type: Number, default: 0 },
    totalRightRatedVolume: { type: Number, default: 0 },
    // Lifetime earned, net of reversals.
    directEarned: { type: Number, default: 0 },
    matchingEarned: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = bindModel('PlotNetwork', plotNetworkSchema, { only: BUSINESSES.T2 });
