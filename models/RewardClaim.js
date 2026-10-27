const mongoose = require('mongoose');
const { bindModel } = require('../utils/businessContext');
const { REWARD_CLAIM_STATUSES } = require('../config/rewards');

const legs = {
  left: { type: Number, required: true, min: 0 },
  right: { type: Number, required: true, min: 0 }
};

/**
 * An associate's claim to one step of their business's reward chart
 * (config/rewards.js). Lives in each business's own database.
 *
 * `volume` is the associate's lifetime business on each leg at the moment of
 * claiming. The newest live claim's volume is where progress toward the next
 * step starts from — that is how a claim resets the count to zero. A rejected
 * claim stops being live, so the associate's progress falls back to before it.
 */
const rewardClaimSchema = new mongoose.Schema(
  {
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true, index: true },
    memberCode: { type: String, required: true },
    // Position in the chart (0-based) and the step / option claimed. The reward
    // and its value are copied in, so a later chart edit never rewrites a claim.
    step: { type: Number, required: true, min: 0 },
    stepLabel: { type: String, required: true },
    option: { type: String, required: true },
    reward: { type: String, required: true },
    rewardValue: { type: Number, required: true, min: 0 },
    target: { type: Number, required: true, min: 0 },
    volume: legs,
    // Where this step's progress was counted from (the previous claim's volume).
    baseline: legs,
    matched: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: Object.values(REWARD_CLAIM_STATUSES),
      default: REWARD_CLAIM_STATUSES.PENDING,
      index: true
    },
    // true while pending or approved. The unique index below is what stops a
    // double-clicked claim, or two tabs, from claiming the same step twice.
    live: { type: Boolean, default: true },
    decision: {
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
      note: { type: String, default: '' }
    }
  },
  { timestamps: true }
);

rewardClaimSchema.index({ associate: 1, step: 1 }, { unique: true, partialFilterExpression: { live: true } });

module.exports = bindModel('RewardClaim', rewardClaimSchema);
