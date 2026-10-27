const mongoose = require('mongoose');
const RewardClaim = require('../models/RewardClaim');
const rewardService = require('../services/rewardService');
const { record } = require('../services/auditService');
const { REWARD_CLAIM_STATUSES } = require('../config/rewards');
const { pageOf, listResponse, searchFilter } = require('../services/plots/helpers');

const REWARD_ACTIONS = {
  CLAIMED: 'reward.claimed',
  APPROVED: 'reward.approved',
  REJECTED: 'reward.rejected'
};

const claimsOf = (associateId) => RewardClaim.find({ associate: associateId }).sort({ createdAt: -1 }).lean();

// ---------------------------------------------------------------------------
// GET /api/rewards/me — the caller's chart, progress since their last claim,
// and every claim they have made. The id comes from the token.
// ---------------------------------------------------------------------------
exports.getMine = async (req, res, next) => {
  try {
    const [standing, claims] = await Promise.all([rewardService.standingOf(req.user._id), claimsOf(req.user._id)]);
    const { chart, volume, baseline, progress, matched, stepIndex, pending } = standing;
    res.status(200).json({
      success: true,
      data: { chart, volume, baseline, progress, matched, stepIndex, pendingClaim: pending?._id ?? null, claims }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// POST /api/rewards/me/claims { option } — claim a reward on the current step.
// ---------------------------------------------------------------------------
exports.claimMine = async (req, res, next) => {
  try {
    const claim = await rewardService.claim(req.user, String(req.body.option || ''));
    await record(req, {
      action: REWARD_ACTIONS.CLAIMED,
      targetType: 'RewardClaim',
      target: claim._id,
      targetCode: claim.memberCode,
      after: { step: claim.stepLabel, reward: claim.reward, matched: claim.matched }
    });
    res.status(201).json({ success: true, message: `${claim.reward} claimed — waiting for approval.`, data: claim });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Admin: GET /api/rewards/chart — the open business's reward chart, as is.
// ---------------------------------------------------------------------------
exports.getChart = (req, res) => res.status(200).json({ success: true, data: rewardService.chartOf() });

// ---------------------------------------------------------------------------
// Admin: GET /api/rewards/claims — every claim in the open business.
// ---------------------------------------------------------------------------
exports.listClaims = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['memberCode', 'reward']) };
    if (Object.values(REWARD_CLAIM_STATUSES).includes(req.query.status)) filter.status = req.query.status;

    const [rows, total, counts] = await Promise.all([
      RewardClaim.find(filter)
        .populate('associate', 'memberCode fullName phone')
        .populate('decision.by', 'fullName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RewardClaim.countDocuments(filter),
      RewardClaim.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);
    const summary = Object.fromEntries(Object.values(REWARD_CLAIM_STATUSES).map((s) => [s, 0]));
    for (const c of counts) summary[c._id] = c.n;
    return listResponse(res, { rows, total, page, limit, extra: { summary } });
  } catch (error) {
    next(error);
  }
};

const decideClaim = (approve) => async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid claim id.' });
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!approve && !note) return res.status(400).json({ success: false, message: 'A reason for rejecting is required.' });

    const claim = await rewardService.decide(req.params.id, { approve, note, actor: req.user });
    await record(req, {
      action: approve ? REWARD_ACTIONS.APPROVED : REWARD_ACTIONS.REJECTED,
      targetType: 'RewardClaim',
      target: claim._id,
      targetCode: claim.memberCode,
      after: { step: claim.stepLabel, reward: claim.reward },
      note
    });
    res.status(200).json({
      success: true,
      message: approve
        ? `${claim.reward} for ${claim.memberCode} approved.`
        : `${claim.reward} for ${claim.memberCode} rejected.`,
      data: claim
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/rewards/claims/:id/approve { note? }
exports.approveClaim = decideClaim(true);
// POST /api/rewards/claims/:id/reject { note } — the claim stops counting.
exports.rejectClaim = decideClaim(false);
