const { BUSINESSES } = require('./business');

// The reward charts, as issued by the company — one per business. The portal
// draws them from GET /api/rewards/me, and a claim is checked against them, so
// this file is the only place a target or a reward is written down.
//
// A chart is a list of steps, claimed in order. Each step offers one or more
// rewards ("options"); claiming any one of them completes the step. Targets are
// matched business in rupees, needed on BOTH legs (₹10 Lakh = ₹10 Lakh left
// and ₹10 Lakh right), counted only from the associate's previous claim: every
// claim starts the next step from zero, and anything beyond the target at the
// moment of claiming does not carry over.
//
// Rewards are handed over outside the system; approving a claim records that
// the company has accepted it. Nothing here touches commission or payouts.

// Tier I counts in pairs: one pair = ₹50,000 of business on each leg.
const T1_PAIR_VALUE = 50000;
const pairs = (n) => n * T1_PAIR_VALUE;

const REWARD_CHARTS = {
  [BUSINESSES.T1]: {
    title: 'Tier I (Insurance)',
    // Each stage offers the smaller reward at the lower target or the bigger one
    // at the higher — one or the other.
    unit: { label: 'pairs', value: T1_PAIR_VALUE },
    steps: [
      {
        key: 'A',
        label: 'Stage A',
        options: [
          { key: 'A1', target: pairs(30), reward: 'Alto Car', rewardValue: 250000 },
          { key: 'A2', target: pairs(60), reward: 'Swift', rewardValue: 500000 }
        ]
      },
      {
        key: 'B',
        label: 'Stage B',
        options: [
          { key: 'B1', target: pairs(150), reward: 'Scorpio', rewardValue: 1200000 },
          { key: 'B2', target: pairs(350), reward: 'Fortuner', rewardValue: 2500000 }
        ]
      },
      {
        key: 'C',
        label: 'Stage C',
        options: [
          { key: 'C1', target: pairs(500), reward: 'House Land', rewardValue: 5000000 },
          { key: 'C2', target: pairs(1000), reward: 'House Land', rewardValue: 10000000 }
        ]
      }
    ]
  },
  [BUSINESSES.T2]: {
    title: 'Tier II (Plots)',
    unit: null,
    steps: [
      { key: 'L1', label: '10 Lakh', options: [{ key: 'L1', target: 1000000, reward: 'Mobile', rewardValue: 30000 }] },
      { key: 'L2', label: 'Next 50 Lakh', options: [{ key: 'L2', target: 5000000, reward: 'Car Fund', rewardValue: 250000 }] },
      { key: 'L3', label: 'Next 2.5 Cr', options: [{ key: 'L3', target: 25000000, reward: 'Car Fund', rewardValue: 500000 }] },
      { key: 'L4', label: 'Next 5 Cr', options: [{ key: 'L4', target: 50000000, reward: 'Car Fund', rewardValue: 1200000 }] },
      { key: 'L5', label: 'Next 10 Cr', options: [{ key: 'L5', target: 100000000, reward: 'Car Fund', rewardValue: 2500000 }] },
      { key: 'L6', label: 'Next 20 Cr', options: [{ key: 'L6', target: 200000000, reward: 'House Land', rewardValue: 5000000 }] }
    ]
  }
};

const REWARD_CLAIM_STATUSES = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };

module.exports = { REWARD_CHARTS, REWARD_CLAIM_STATUSES };
