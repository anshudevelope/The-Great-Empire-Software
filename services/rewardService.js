const Associate = require('../models/Associate');
const PlotNetwork = require('../models/plots/Network');
const RewardClaim = require('../models/RewardClaim');
const { BUSINESSES } = require('../config/business');
const { REWARD_CHARTS, REWARD_CLAIM_STATUSES } = require('../config/rewards');
const { currentBusiness } = require('../utils/businessContext');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

const chartOf = (business = currentBusiness()) => REWARD_CHARTS[business];

/**
 * Lifetime business on each leg — never carry, which every match consumes.
 * T1: registration volume on the Associate. T2: the commissionable share of
 * plot payments, the same figure the Tier II chart has always been read from.
 */
const volumeOf = async (associateId) => {
  if (currentBusiness() === BUSINESSES.T2) {
    const n = await PlotNetwork.findOne({ associate: associateId }).select('totalLeftRatedVolume totalRightRatedVolume').lean();
    return { left: round2(n?.totalLeftRatedVolume), right: round2(n?.totalRightRatedVolume) };
  }
  const a = await Associate.findById(associateId).select('totalLeftVolume totalRightVolume').lean();
  return { left: round2(a?.totalLeftVolume), right: round2(a?.totalRightVolume) };
};

const liveClaims = (associateId) =>
  RewardClaim.find({ associate: associateId, live: true }).sort({ step: 1 }).lean();

/**
 * Where an associate stands on their chart: the step they are on, business
 * counted since their last live claim, and whether they may claim now.
 */
const standingOf = async (associateId) => {
  const chart = chartOf();
  const [volume, live] = await Promise.all([volumeOf(associateId), liveClaims(associateId)]);
  const last = live[live.length - 1] || null;
  const baseline = last ? last.volume : { left: 0, right: 0 };
  const progress = {
    left: round2(Math.max(0, volume.left - baseline.left)),
    right: round2(Math.max(0, volume.right - baseline.right))
  };
  const matched = Math.min(progress.left, progress.right);
  const stepIndex = live.length;
  const step = chart.steps[stepIndex] || null;
  const pending = live.find((c) => c.status === REWARD_CLAIM_STATUSES.PENDING) || null;
  return { chart, volume, baseline, progress, matched, stepIndex, step, pending };
};

/**
 * Claim one option of the associate's current step. Checked here against the
 * chart and their live figures, never against what the page showed.
 */
const claim = async (associate, optionKey) => {
  const s = await standingOf(associate._id);
  if (!s.step) throw httpError('Every reward on the chart has already been claimed.', 409);
  if (s.pending) throw httpError('Your previous claim is still waiting for approval.', 409);

  const option = s.step.options.find((o) => o.key === optionKey);
  if (!option) throw httpError('That reward is not on your current step.');
  if (s.matched < option.target) throw httpError('This target has not been reached yet.');

  try {
    return await RewardClaim.create({
      associate: associate._id,
      memberCode: associate.memberCode,
      step: s.stepIndex,
      stepLabel: s.step.label,
      option: option.key,
      reward: option.reward,
      rewardValue: option.rewardValue,
      target: option.target,
      volume: s.volume,
      baseline: s.baseline,
      matched: s.matched
    });
  } catch (err) {
    if (err?.code === 11000) throw httpError('This step has already been claimed.', 409);
    throw err;
  }
};

/** Approve or reject a pending claim. A rejected claim stops counting. */
const decide = async (claimId, { approve, note, actor }) => {
  const update = approve
    ? { status: REWARD_CLAIM_STATUSES.APPROVED }
    : { status: REWARD_CLAIM_STATUSES.REJECTED, live: false };
  const claimDoc = await RewardClaim.findOneAndUpdate(
    { _id: claimId, status: REWARD_CLAIM_STATUSES.PENDING },
    { $set: { ...update, decision: { at: new Date(), by: actor._id, note } } },
    { returnDocument: 'after' }
  );
  if (!claimDoc) {
    const exists = await RewardClaim.exists({ _id: claimId });
    throw exists ? httpError('This claim has already been decided.', 409) : httpError('Claim not found.', 404);
  }
  return claimDoc;
};

module.exports = { chartOf, standingOf, claim, decide };
