const Associate = require('../../models/Associate');
const PlotCommission = require('../../models/plots/Commission');
const PlotPayout = require('../../models/plots/Payout');
const { COMMISSION_TYPES, PAYOUT_STATUSES } = require('../../config/constants');
const { PLOT_PAYOUT } = require('../../config/plotConfig');
const { withTransaction } = require('../../utils/transaction');
const { round2, httpError, nextCode } = require('./helpers');

/**
 * Plot-commission closings — separate from registration payouts.
 *
 * Rows are picked by: not yet paid, not a zero marker, created on or before
 * the period end. A member whose total for the period is zero or negative gets
 * no line; their rows stay unpaid and simply roll into the next closing.
 */
const unpaidFilter = (periodEnd) => ({ payout: null, amount: { $ne: 0 }, createdAt: { $lte: periodEnd } });

const computeLines = async (periodEnd, rates) => {
  const earned = await PlotCommission.aggregate([
    { $match: unpaidFilter(periodEnd) },
    {
      $group: {
        _id: '$beneficiary',
        code: { $first: '$beneficiaryCode' },
        direct: { $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.DIRECT] }, '$amount', 0] } },
        matching: { $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.MATCHING] }, '$amount', 0] } },
        reversals: { $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.REVERSAL] }, '$amount', 0] } },
        rowCount: { $sum: 1 }
      }
    }
  ]);

  const names = new Map(
    (await Associate.find({ _id: { $in: earned.map((e) => e._id) } }).select('fullName').lean()).map((a) => [
      String(a._id),
      a.fullName
    ])
  );

  return earned
    .map((e) => {
      const direct = round2(e.direct);
      const matching = round2(e.matching);
      const reversals = round2(e.reversals);
      const total = round2(direct + matching + reversals);
      const adminCharge = round2(total * rates.adminChargePct);
      const tds = round2(total * rates.tdsPct);
      return {
        member: e._id,
        memberCode: e.code,
        fullName: names.get(String(e._id)) || e.code,
        direct,
        matching,
        reversals,
        total,
        adminCharge,
        tds,
        netPayable: round2(total - adminCharge - tds),
        rowCount: e.rowCount
      };
    })
    .filter((l) => l.total > 0)
    .sort((a, b) => a.memberCode.localeCompare(b.memberCode));
};

const totalsOf = (lines) => {
  const add = (k) => round2(lines.reduce((s, l) => s + (l[k] || 0), 0));
  return {
    members: lines.length,
    direct: add('direct'),
    matching: add('matching'),
    reversals: add('reversals'),
    gross: add('total'),
    adminCharge: add('adminCharge'),
    tds: add('tds'),
    netPayable: add('netPayable')
  };
};

const generateDraft = async ({ periodEnd, actor, note = '' }) => {
  const end = periodEnd ? new Date(periodEnd) : new Date();
  if (Number.isNaN(end.getTime())) throw httpError('Invalid period end date.');
  // Include the whole of the chosen day.
  end.setHours(23, 59, 59, 999);

  if (await PlotPayout.exists({ status: PAYOUT_STATUSES.DRAFT })) {
    throw httpError('A draft plot payout already exists. Finalize or discard it first.', 409);
  }

  const rates = { adminChargePct: PLOT_PAYOUT.adminChargePct, tdsPct: PLOT_PAYOUT.tdsPct };
  const lines = await computeLines(end, rates);
  if (!lines.length) throw httpError('Nothing to pay for this period.', 400);

  return PlotPayout.create({
    payoutNo: await nextCode('payout'),
    status: PAYOUT_STATUSES.DRAFT,
    periodEnd: end,
    rates,
    lines,
    totals: totalsOf(lines),
    note,
    generatedBy: actor?._id ?? null
  });
};

/**
 * Stamp every row the draft was built from, in one transaction. The draft is
 * recomputed first: if a payment, reversal or cancellation landed since it was
 * generated, the figures would no longer match what the admin approved, so it
 * refuses rather than paying different numbers.
 */
const finalize = async (payoutId, actor) => {
  const payout = await PlotPayout.findById(payoutId);
  if (!payout) throw httpError('Plot payout not found.', 404);
  if (payout.status !== PAYOUT_STATUSES.DRAFT) throw httpError('Only a draft can be finalized.', 409);

  const fresh = await computeLines(payout.periodEnd, payout.rates);
  const same =
    fresh.length === payout.lines.length &&
    fresh.every((l, i) => String(l.member) === String(payout.lines[i].member) && l.total === payout.lines[i].total);
  if (!same) {
    throw httpError('Commission changed since this draft was generated. Discard it and generate again.', 409);
  }

  const members = payout.lines.map((l) => l.member);
  await withTransaction(async (session) => {
    await PlotCommission.updateMany(
      { ...unpaidFilter(payout.periodEnd), beneficiary: { $in: members } },
      { $set: { payout: payout._id } },
      { session }
    );
    payout.status = PAYOUT_STATUSES.FINALIZED;
    payout.finalizedAt = new Date();
    payout.finalizedBy = actor?._id ?? null;
    await payout.save({ session });
  });
  return payout;
};

/** Lift the stamps: the rows become unpaid again and join the next closing. */
const cancel = async (payoutId, actor, reason = '') => {
  const payout = await PlotPayout.findById(payoutId);
  if (!payout) throw httpError('Plot payout not found.', 404);
  if (payout.status !== PAYOUT_STATUSES.FINALIZED) throw httpError('Only a finalized payout can be cancelled.', 409);

  await withTransaction(async (session) => {
    await PlotCommission.updateMany({ payout: payout._id }, { $set: { payout: null } }, { session });
    payout.status = PAYOUT_STATUSES.CANCELLED;
    payout.cancelledAt = new Date();
    payout.cancelledBy = actor?._id ?? null;
    payout.cancelReason = reason;
    await payout.save({ session });
  });
  return payout;
};

const discard = async (payoutId) => {
  const payout = await PlotPayout.findById(payoutId);
  if (!payout) throw httpError('Plot payout not found.', 404);
  if (payout.status !== PAYOUT_STATUSES.DRAFT) throw httpError('Only a draft can be discarded.', 409);
  await payout.deleteOne();
};

module.exports = { generateDraft, finalize, cancel, discard, computeLines };
