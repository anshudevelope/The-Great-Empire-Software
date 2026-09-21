const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const CommissionLedger = require('../models/CommissionLedger');
const PayoutBatch = require('../models/PayoutBatch');
const PayoutLine = require('../models/PayoutLine');
const Setting = require('../models/Setting');
const { withTransaction } = require('../utils/transaction');
const { nextPayoutNo } = require('../utils/codes');
const {
  COMMISSION_TYPES,
  PAYOUT_STATUSES,
  SETTING_KEYS,
  ROLES,
  STATUSES
} = require('../config/constants');

// Rupees, 2dp. Applied per line, never to a batch total — see summarise().
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Turn one member's raw period figures into a payout line. Pure — no database,
 * no mongoose. This is where the money is decided, so it is the part that gets
 * tested directly.
 *
 * Both deductions are 5% of the GROSS total. Neither compounds on the other:
 * on 27,500 that is 1,375 + 1,375, not 1,375 then 5% of 26,125.
 *
 * Two cases are HELD rather than paid, and in both the gross total rolls into
 * the next batch untouched — no charge is levied on money that is not going
 * out:
 *
 *   negative        a commission reversed after it was already paid drags the
 *                   period below zero. The system must not "pay" a negative, so
 *                   the shortfall becomes next period's opening balance.
 *   below-minimum   under the configured floor. Rolled forward rather than
 *                   skipped, or a small earner would simply never be paid.
 */
const computeLine = (raw, rates) => {
  const direct = round2(raw.direct || 0);
  const matching = round2(raw.matching || 0);
  const reversals = round2(raw.reversals || 0);
  const openingAdjustment = round2(raw.openingAdjustment || 0);

  const total = round2(direct + matching + reversals + openingAdjustment);

  const held = (reason) => ({
    direct,
    matching,
    reversals,
    openingAdjustment,
    total,
    adminCharge: 0,
    secondaryCharge: 0,
    netPayable: 0,
    heldReason: reason,
    rollForward: total
  });

  if (total < 0) return held('negative');
  if (total === 0) {
    return {
      direct,
      matching,
      reversals,
      openingAdjustment,
      total: 0,
      adminCharge: 0,
      secondaryCharge: 0,
      netPayable: 0,
      heldReason: null,
      rollForward: 0
    };
  }

  const adminCharge = round2(total * rates.adminChargePct);
  const secondaryCharge = round2(total * rates.secondaryChargePct);
  const netPayable = round2(total - adminCharge - secondaryCharge);

  const floor = rates.minimumPayable || 0;
  if (floor > 0 && netPayable < floor) return held('below-minimum');

  return {
    direct,
    matching,
    reversals,
    openingAdjustment,
    total,
    adminCharge,
    secondaryCharge,
    netPayable,
    heldReason: null,
    rollForward: 0
  };
};

/**
 * Batch totals.
 *
 * Sums the already-rounded lines. Never recompute a total from unrounded
 * inputs: it will disagree with the sum of its own lines by a few paise, and
 * every reconciliation afterwards spends its time chasing that difference.
 */
const summarise = (lines) => {
  const add = (key) => round2(lines.reduce((sum, l) => sum + (l[key] || 0), 0));

  return {
    members: lines.filter((l) => l.total !== 0).length,
    grossDirect: add('direct'),
    grossMatching: add('matching'),
    grossReversals: add('reversals'),
    gross: add('total'),
    adminCharge: add('adminCharge'),
    secondaryCharge: add('secondaryCharge'),
    netPayable: add('netPayable'),
    carryFlushed: round2(
      lines.reduce((sum, l) => sum + (l.carryBefore?.left || 0) + (l.carryBefore?.right || 0), 0)
    ),
    ledgerRows: lines.reduce((sum, l) => sum + (l.ledgerRowCount || 0), 0)
  };
};

/** Current rates, defaults filled in, as one consistent snapshot. */
const currentRates = async () => {
  const s = await Setting.getAll();
  return {
    adminChargePct: s[SETTING_KEYS.ADMIN_CHARGE_PCT],
    secondaryChargePct: s[SETTING_KEYS.SECONDARY_CHARGE_PCT],
    secondaryChargeLabel: s[SETTING_KEYS.SECONDARY_CHARGE_LABEL],
    flushCarryOnClose: s[SETTING_KEYS.FLUSH_CARRY_ON_CLOSE],
    minimumPayable: s[SETTING_KEYS.MINIMUM_PAYABLE],
    includeZeroIncomeMembers: s[SETTING_KEYS.INCLUDE_ZERO_INCOME]
  };
};

/**
 * Where this period begins: the day AFTER the last finalized one ended.
 *
 * Periods read as inclusive date ranges, so a payout closed on the 22nd is
 * followed by one starting on the 23rd. Returning the previous end unchanged
 * would print the same date as both the end of one period and the start of the
 * next, which reads like an overlap.
 *
 * This value is metadata: row selection is driven by `payoutBatch: null` plus
 * the close date, never by the period start, so nothing earned in the gap can
 * be missed — an unpaid row stays unpaid until some batch's close date covers it.
 *
 * On a first run there is no previous batch, so fall back to the oldest unpaid
 * ledger row — and to now if the ledger is empty.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const resolvePeriodStart = async () => {
  const last = await PayoutBatch.findOne({ status: PAYOUT_STATUSES.FINALIZED })
    .sort({ periodEnd: -1 })
    .select('periodEnd')
    .lean();
  if (last) return new Date(last.periodEnd.getTime() + DAY_MS);

  const oldest = await CommissionLedger.findOne({ payoutBatch: null })
    .sort({ createdAt: 1 })
    .select('createdAt')
    .lean();
  return oldest ? oldest.createdAt : new Date();
};

/**
 * Amounts held back by the previous finalized batch, to be added to this one.
 */
const openingAdjustments = async () => {
  const last = await PayoutBatch.findOne({ status: PAYOUT_STATUSES.FINALIZED })
    .sort({ periodEnd: -1 })
    .select('_id')
    .lean();
  if (!last) return new Map();

  const held = await PayoutLine.find({ batch: last._id, heldReason: { $ne: null } })
    .select('member total')
    .lean();

  return new Map(held.map((l) => [String(l.member), l.total]));
};

/**
 * Build the lines for a period. Reads only — nothing is written and no ledger
 * row is stamped, so a draft is completely discardable.
 */
const buildLines = async ({ periodEnd, rates }) => {
  const earned = await CommissionLedger.aggregate([
    { $match: { payoutBatch: null, createdAt: { $lte: periodEnd } } },
    {
      $group: {
        _id: '$beneficiary',
        direct: {
          $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.DIRECT] }, '$amount', 0] }
        },
        matching: {
          $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.MATCHING] }, '$amount', 0] }
        },
        reversals: {
          $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.REVERSAL] }, '$amount', 0] }
        },
        ledgerRowCount: { $sum: 1 }
      }
    }
  ]);

  const byMember = new Map(earned.map((e) => [String(e._id), e]));
  const opening = await openingAdjustments();

  // ------------------------------------------------------------------
  // Who gets a line.
  // ------------------------------------------------------------------
  // Income alone is not the test. When carry is being flushed, a member holding
  // carry but no income STILL needs a line — carryBefore is the only record of
  // what the flush destroyed, and without it cancelling the batch could not put
  // their carry back.
  const or = [
    { _id: { $in: earned.map((e) => e._id) } },
    ...(rates.flushCarryOnClose
      ? [{ carryLeft: { $gt: 0 } }, { carryRight: { $gt: 0 } }]
      : []),
    ...(opening.size ? [{ _id: { $in: [...opening.keys()].map((id) => new mongoose.Types.ObjectId(id)) } }] : [])
  ];

  const filter = rates.includeZeroIncomeMembers
    ? { role: ROLES.ASSOCIATE, status: STATUSES.APPROVED }
    : { role: ROLES.ASSOCIATE, $or: or };

  // An empty $or matches nothing and Mongo rejects it outright.
  if (!rates.includeZeroIncomeMembers && !or.length) return [];

  const members = await Associate.find(filter)
    .select('memberCode fullName tier carryLeft carryRight')
    .sort({ memberCode: 1 })
    .lean();

  const lines = members.map((m) => {
    const raw = byMember.get(String(m._id)) || {};
    const computed = computeLine(
      { ...raw, openingAdjustment: opening.get(String(m._id)) || 0 },
      rates
    );

    return {
      member: m._id,
      memberCode: m.memberCode,
      fullName: m.fullName,
      pan: '', // no source field yet — PAYOUT-ENGINE-PLAN.md §7.1
      tier: m.tier,
      ...computed,
      carryBefore: rates.flushCarryOnClose
        ? { left: m.carryLeft || 0, right: m.carryRight || 0 }
        : { left: 0, right: 0 },
      ledgerRowCount: raw.ledgerRowCount || 0
    };
  });

  if (rates.includeZeroIncomeMembers) return lines;

  // Nothing to pay, nothing to record — drop the line entirely.
  //
  // Being in the "earned" set is not the same as having earned anything. A
  // member placed without a referral carries a deliberate zero-value marker row
  // (see commissionService.onPlacement), and a member whose bonus was reversed
  // nets to zero from two real rows. Both would otherwise appear on the payout
  // sheet and in the CSV as ₹0.00 lines that no one can act on.
  //
  // The exception is a flush: carryBefore is the only record of what a closing
  // destroyed, so a member holding carry keeps their line even with no income,
  // or cancelling the batch could not put that carry back.
  return lines.filter(
    (line) =>
      line.total !== 0 ||
      (rates.flushCarryOnClose && (line.carryBefore.left > 0 || line.carryBefore.right > 0))
  );
};

/**
 * Rebuild directIncome / matchingIncome from the ledger for the given members.
 *
 * Finalize CANNOT simply set these to zero. A member may have earned commission
 * after the cutoff but before the button was pressed — that money is unpaid and
 * belongs to the next period, and zeroing would silently destroy it. Nor can it
 * decrement by the paid amounts, because reversals have already moved the cache
 * once. Recomputing from whatever rows remain unstamped is the only version
 * that is exact, and it is the same expression verifyCommissions checks.
 */
const recacheIncome = async (memberIds, session = null) => {
  if (!memberIds.length) return;

  const rows = await CommissionLedger.aggregate([
    { $match: { beneficiary: { $in: memberIds }, payoutBatch: null } },
    {
      $group: {
        _id: '$beneficiary',
        direct: { $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.DIRECT] }, '$amount', 0] } },
        matching: { $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.MATCHING] }, '$amount', 0] } },
        reversals: { $sum: { $cond: [{ $eq: ['$type', COMMISSION_TYPES.REVERSAL] }, '$amount', 0] } }
      }
    }
  ]).session(session);

  const remaining = new Map(rows.map((r) => [String(r._id), r]));

  await Associate.bulkWrite(
    memberIds.map((id) => {
      const r = remaining.get(String(id)) || { direct: 0, matching: 0, reversals: 0 };
      // A reversal is not typed by what it undid, so it is folded into the
      // direct bucket — the same place reverseRow() adjusts. The pair still
      // sums to the member's true unpaid balance.
      return {
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              directIncome: round2(r.direct + r.reversals),
              matchingIncome: round2(r.matching)
            }
          }
        }
      };
    }),
    { session }
  );
};

/**
 * Build a DRAFT batch. Writes the batch and its lines and nothing else — no
 * ledger row is stamped and no member is touched, so a draft is completely
 * discardable.
 */
const generateDraft = async ({ periodEnd, actor, note = '' }) => {
  const rates = await currentRates();
  const periodStart = await resolvePeriodStart();
  const cutoff = periodEnd ? new Date(periodEnd) : new Date();

  if (Number.isNaN(cutoff.getTime())) {
    const err = new Error('Close date is not a valid date.');
    err.status = 400;
    throw err;
  }

  // The close date is deliberately unconstrained — future or past is the
  // admin's call. It cannot cause a double payment either way: rows are
  // selected by `payoutBatch: null`, so anything already paid is invisible to
  // this batch no matter what date is chosen. A date that covers nothing falls
  // through to the "nothing to pay out" check below.

  const lines = await buildLines({ periodEnd: cutoff, rates });
  if (!lines.length) {
    const err = new Error('Nothing to pay out — no unpaid commission in this period.');
    err.status = 400;
    throw err;
  }

  const batchNo = await nextPayoutNo();

  let batch;
  try {
    [batch] = await PayoutBatch.create([
      {
        batchNo,
        periodStart,
        periodEnd: cutoff,
        status: PAYOUT_STATUSES.DRAFT,
        rates: {
          adminChargePct: rates.adminChargePct,
          secondaryChargePct: rates.secondaryChargePct,
          secondaryChargeLabel: rates.secondaryChargeLabel,
          flushCarryOnClose: rates.flushCarryOnClose,
          minimumPayable: rates.minimumPayable
        },
        totals: summarise(lines),
        generatedBy: actor._id,
        generatedByCode: actor.memberCode || '',
        note
      }
    ]);
  } catch (err) {
    // The partial unique index on status:'draft' — someone else is already
    // holding an open draft.
    if (err?.code === 11000) {
      const clash = new Error(
        'A draft payout already exists. Finalize or discard it before generating another.'
      );
      clash.status = 409;
      throw clash;
    }
    throw err;
  }

  await PayoutLine.insertMany(
    lines.map((l) => ({ ...l, batch: batch._id, batchNo }))
  );

  return batch;
};

/**
 * Commit a draft. The only step that changes anyone's balance.
 *
 * Order matters: the status flip comes first and is conditional, so a
 * double-clicked button cannot finalize twice. Everything after it is safe to
 * have run once.
 */
const finalizeBatch = async (batchId, actor) => {
  return withTransaction(async (session) => {
    // Conditional flip — whoever matches this first owns the finalize.
    const batch = await PayoutBatch.findOneAndUpdate(
      { _id: batchId, status: PAYOUT_STATUSES.DRAFT },
      {
        status: PAYOUT_STATUSES.FINALIZED,
        finalizedBy: actor._id,
        finalizedAt: new Date()
      },
      { returnDocument: 'after', session }
    );

    if (!batch) {
      const err = new Error('That payout is not a draft — it may already have been finalized.');
      err.status = 409;
      throw err;
    }

    // The carry snapshot the admin actually approved, taken when the draft was
    // generated. Read before the lines are rebuilt, because rebuilding would
    // pick up whatever has accumulated since — see PAYOUT-ENGINE-PLAN.md §7.6.
    const draftLines = await PayoutLine.find({ batch: batch._id })
      .select('member carryBefore')
      .lean()
      .session(session);
    const approvedCarry = new Map(draftLines.map((l) => [String(l.member), l.carryBefore]));

    // MONEY is recomputed from the ledger — the draft is a view, the ledger is
    // the truth, and a late settle() may have landed a row inside the period.
    const lines = await buildLines({ periodEnd: batch.periodEnd, rates: batch.rates });

    // CARRY is not recomputed. It keeps the approved snapshot so that the
    // number on the preview is the number destroyed, and so that volume from a
    // placement made after the cutoff survives the closing — exactly as the
    // income from that same placement does.
    for (const line of lines) {
      line.carryBefore = approvedCarry.get(String(line.member)) || { left: 0, right: 0 };
      line.carryFlushed = { left: 0, right: 0 };
    }

    // Stamp every unpaid row in the period. This is what makes the member's
    // current-period income fall to zero, and what stops any row being paid
    // a second time.
    const stamped = await CommissionLedger.updateMany(
      { payoutBatch: null, createdAt: { $lte: batch.periodEnd } },
      { payoutBatch: batch._id },
      { session }
    );

    const memberIds = lines.map((l) => l.member);
    await recacheIncome(memberIds, session);

    if (batch.rates.flushCarryOnClose) {
      const live = await Associate.find({ _id: { $in: memberIds } })
        .select('carryLeft carryRight')
        .lean()
        .session(session);
      const liveById = new Map(live.map((a) => [String(a._id), a]));

      const ops = [];
      for (const line of lines) {
        const now = liveById.get(String(line.member)) || {};
        // Clamped. A placement on the opposite leg after the cutoff can pair
        // off some of the approved carry before this runs, and subtracting the
        // full snapshot would drive the balance negative.
        const left = Math.min(now.carryLeft || 0, line.carryBefore.left || 0);
        const right = Math.min(now.carryRight || 0, line.carryBefore.right || 0);
        line.carryFlushed = { left, right };

        if (left || right) {
          ops.push({
            updateOne: {
              filter: { _id: line.member },
              update: { $inc: { carryLeft: -left, carryRight: -right } }
            }
          });
        }
      }
      if (ops.length) await Associate.bulkWrite(ops, { session });
    }

    // summarise() projects carryFlushed from carryBefore, which is right for a
    // draft. Now that the flush has run, replace it with what was really taken.
    const totals = summarise(lines);
    totals.carryFlushed = round2(
      lines.reduce((sum, l) => sum + l.carryFlushed.left + l.carryFlushed.right, 0)
    );

    await PayoutLine.deleteMany({ batch: batch._id }, { session });
    await PayoutLine.insertMany(
      lines.map((l) => ({ ...l, batch: batch._id, batchNo: batch.batchNo })),
      { session }
    );
    await PayoutBatch.updateOne({ _id: batch._id }, { totals }, { session });

    return { batch: { ...batch.toObject(), totals }, stampedRows: stamped.modifiedCount };
  });
};

/**
 * Undo a finalized batch.
 *
 * Only possible because every line carries carryBefore. Money may already have
 * left the bank, so the caller is responsible for warning loudly.
 */
const cancelBatch = async (batchId, actor, reason) => {
  return withTransaction(async (session) => {
    const batch = await PayoutBatch.findOneAndUpdate(
      { _id: batchId, status: PAYOUT_STATUSES.FINALIZED },
      {
        status: PAYOUT_STATUSES.CANCELLED,
        cancelledBy: actor._id,
        cancelledAt: new Date(),
        cancelReason: reason
      },
      { returnDocument: 'after', session }
    );

    if (!batch) {
      const err = new Error('Only a finalized payout can be cancelled.');
      err.status = 409;
      throw err;
    }

    // Un-stamp: those rows become unpaid again.
    await CommissionLedger.updateMany(
      { payoutBatch: batch._id },
      { payoutBatch: null },
      { session }
    );

    const lines = await PayoutLine.find({ batch: batch._id })
      .select('member carryFlushed')
      .lean()
      .session(session);

    if (batch.rates.flushCarryOnClose) {
      const ops = lines
        // Restore from carryFlushed, not carryBefore: the flush is clamped, so
        // giving back the snapshot when less was taken would invent carry.
        .filter((l) => l.carryFlushed?.left || l.carryFlushed?.right)
        .map((l) => ({
          updateOne: {
            filter: { _id: l.member },
            // $inc, not $set: carry may have grown from placements made since
            // the closing, and those must not be discarded by the restore.
            update: {
              $inc: { carryLeft: l.carryFlushed.left || 0, carryRight: l.carryFlushed.right || 0 }
            }
          }
        }));
      if (ops.length) await Associate.bulkWrite(ops, { session });
    }

    await recacheIncome(lines.map((l) => l.member), session);

    return batch;
  });
};

/** Throw away a draft. Nothing was committed, so nothing needs undoing. */
const discardDraft = async (batchId) => {
  const batch = await PayoutBatch.findOneAndDelete({
    _id: batchId,
    status: PAYOUT_STATUSES.DRAFT
  });
  if (!batch) {
    const err = new Error('No draft payout with that id.');
    err.status = 404;
    throw err;
  }
  await PayoutLine.deleteMany({ batch: batch._id });
  return batch;
};

module.exports = {
  computeLine,
  summarise,
  currentRates,
  resolvePeriodStart,
  openingAdjustments,
  buildLines,
  recacheIncome,
  generateDraft,
  finalizeBatch,
  cancelBatch,
  discardDraft,
  round2
};
