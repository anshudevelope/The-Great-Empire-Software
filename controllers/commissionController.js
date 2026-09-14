const mongoose = require('mongoose');
const CommissionLedger = require('../models/CommissionLedger');
const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const { reverseRow } = require('../services/commissionService');
const { record, ACTIONS } = require('../services/auditService');
const { streamCsv } = require('../utils/csv');
const { COMMISSION_TYPES, ROLES, REFERRAL_STATUSES } = require('../config/constants');

const MAX_LIMIT = 200;

/**
 * Shared filter builder for every ledger listing.
 *
 * `beneficiary` is always applied by the caller, never read from the query
 * string — a report route that lets the client choose whose ledger to read is
 * exactly how a member ends up reading someone else's income.
 */
const buildFilter = ({ type, from, to, sourceMember }) => {
  const filter = {};

  if (type && Object.values(COMMISSION_TYPES).includes(type)) filter.type = type;
  if (sourceMember && mongoose.isValidObjectId(sourceMember)) filter.sourceMember = sourceMember;

  if (from || to) {
    filter.createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) filter.createdAt.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      // An inclusive end date: "to=2026-09-14" should include that whole day.
      if (!Number.isNaN(d.getTime())) filter.createdAt.$lte = new Date(d.setUTCHours(23, 59, 59, 999));
    }
    if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
  }

  return filter;
};

const parsePaging = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * Totals for one member, computed FROM THE LEDGER rather than read from the
 * denormalised fields on Associate. Those fields are a cache; this is the
 * number that has to be defensible in a dispute.
 */
const ledgerTotals = async (beneficiaryId) => {
  const rows = await CommissionLedger.aggregate([
    { $match: { beneficiary: new mongoose.Types.ObjectId(String(beneficiaryId)) } },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]);

  const byType = Object.fromEntries(rows.map((r) => [r._id, r]));
  const direct = byType[COMMISSION_TYPES.DIRECT]?.total || 0;
  const matching = byType[COMMISSION_TYPES.MATCHING]?.total || 0;
  const reversed = byType[COMMISSION_TYPES.REVERSAL]?.total || 0;

  return {
    directIncome: direct,
    matchingIncome: matching,
    reversals: reversed,
    totalIncome: Math.round((direct + matching + reversed) * 100) / 100,
    rowCount: rows.reduce((sum, r) => sum + r.count, 0)
  };
};

const listFor = async (beneficiaryId, req, res) => {
  const { page, limit, skip } = parsePaging(req.query);
  const filter = { ...buildFilter(req.query), beneficiary: beneficiaryId };

  const [rows, total] = await Promise.all([
    CommissionLedger.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CommissionLedger.countDocuments(filter)
  ]);

  return res.status(200).json({
    success: true,
    data: rows,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
};

// ---------------------------------------------------------------------------
// 1. GET /api/commissions/me — the caller's own ledger
// ---------------------------------------------------------------------------
exports.getMyLedger = (req, res, next) =>
  listFor(req.user._id, req, res).catch(next);

// ---------------------------------------------------------------------------
// 2. GET /api/commissions/me/summary
// ---------------------------------------------------------------------------
exports.getMySummary = async (req, res, next) => {
  try {
    const me = await Associate.findById(req.user._id)
      .select('memberCode carryLeft carryRight totalLeftVolume totalRightVolume directIncome matchingIncome')
      .lean();

    const totals = await ledgerTotals(req.user._id);

    // Carry is what the next pairing will draw on: whichever leg is weaker is
    // the ceiling on the next match.
    const matchable = Math.min(me.carryLeft, me.carryRight);

    res.status(200).json({
      success: true,
      data: {
        memberCode: me.memberCode,
        ...totals,
        carry: {
          left: me.carryLeft,
          right: me.carryRight,
          matchable,
          // Which side needs volume for the next pair to form.
          weakerLeg: me.carryLeft === me.carryRight ? null : me.carryLeft < me.carryRight ? 'Left' : 'Right'
        },
        volume: { left: me.totalLeftVolume, right: me.totalRightVolume },
        // Surfaced so drift between the cache and the ledger is visible rather
        // than silently trusted. Should always be zero.
        cacheDrift: {
          direct: Math.round((me.directIncome - totals.directIncome) * 100) / 100,
          matching: Math.round((me.matchingIncome - totals.matchingIncome) * 100) / 100
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 3. GET /api/commissions/member/:id — scoped by scopeToDownline
// ---------------------------------------------------------------------------
exports.getMemberLedger = async (req, res, next) => {
  try {
    const member = await Associate.findById(req.params.id).select('memberCode fullName').lean();
    if (!member) return res.status(404).json({ success: false, message: 'Associate not found.' });

    return listFor(member._id, req, res);
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 4. GET /api/commissions/member/:id/summary
// ---------------------------------------------------------------------------
exports.getMemberSummary = async (req, res, next) => {
  try {
    const member = await Associate.findById(req.params.id)
      .select('memberCode fullName carryLeft carryRight totalLeftVolume totalRightVolume')
      .lean();
    if (!member) return res.status(404).json({ success: false, message: 'Associate not found.' });

    const totals = await ledgerTotals(member._id);

    res.status(200).json({
      success: true,
      data: {
        memberCode: member.memberCode,
        fullName: member.fullName,
        ...totals,
        carry: { left: member.carryLeft, right: member.carryRight },
        volume: { left: member.totalLeftVolume, right: member.totalRightVolume }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 5. GET /api/commissions/admin — company-wide ledger (admin only)
// ---------------------------------------------------------------------------
exports.getAdminLedger = async (req, res, next) => {
  try {
    const filter = buildFilter(req.query);
    if (req.query.beneficiary && mongoose.isValidObjectId(req.query.beneficiary)) {
      filter.beneficiary = req.query.beneficiary;
    }

    if (req.query.format === 'csv') {
      const columns = [
        { header: 'Date', value: (d) => d.createdAt },
        { header: 'Type', value: (d) => d.type },
        { header: 'Beneficiary', value: (d) => d.beneficiaryCode },
        { header: 'Amount', value: (d) => d.amount },
        { header: 'Tier', value: (d) => d.tier },
        { header: 'Source Member', value: (d) => d.sourceMemberCode },
        { header: 'Rate', value: (d) => d.basis?.rate },
        { header: 'Base', value: (d) => d.basis?.base },
        { header: 'Leg', value: (d) => d.basis?.legSide || '' },
        { header: 'Depth', value: (d) => d.basis?.depthFromSource ?? '' },
        { header: 'Carry L Before', value: (d) => d.basis?.carryLeftBefore ?? '' },
        { header: 'Carry R Before', value: (d) => d.basis?.carryRightBefore ?? '' },
        { header: 'Note', value: (d) => d.note || '' }
      ];
      const cursor = CommissionLedger.find(filter).sort({ createdAt: -1 }).cursor();
      return streamCsv(res, `commissions-${Date.now()}.csv`, columns, cursor);
    }

    const { page, limit, skip } = parsePaging(req.query);
    const [rows, total] = await Promise.all([
      CommissionLedger.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommissionLedger.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 6. GET /api/commissions/admin/liability — the outflow ratio (§9.3)
//
// Matching is uncapped and carry is never flushed, so nothing in the engine
// limits what the plan can owe. This is the instrument that makes that visible
// continuously instead of at payout time.
// ---------------------------------------------------------------------------
exports.getLiability = async (req, res, next) => {
  try {
    const [inflowRows, outflowRows, carryRows] = await Promise.all([
      Referral.aggregate([
        { $match: { status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] } } },
        { $group: { _id: null, total: { $sum: '$amountPaid' }, count: { $sum: 1 } } }
      ]),
      CommissionLedger.aggregate([
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      // openCarry: for every member, the volume already sitting on BOTH legs
      // that will pay the moment a counterpart lands. It is money the plan
      // already owes and it appears nowhere in outflow until it pays.
      Associate.aggregate([
        { $match: { carryLeft: { $gt: 0 }, carryRight: { $gt: 0 } } },
        { $project: { matchable: { $min: ['$carryLeft', '$carryRight'] } } },
        { $group: { _id: null, total: { $sum: '$matchable' }, members: { $sum: 1 } } }
      ])
    ]);

    const inflow = inflowRows[0]?.total || 0;
    const byType = Object.fromEntries(outflowRows.map((r) => [r._id, r.total]));
    const outflow = outflowRows.reduce((sum, r) => sum + r.total, 0);

    const openCarry = carryRows[0]?.total || 0;
    const matchingRate = 0.05;
    const committed = Math.round(openCarry * matchingRate * 100) / 100;

    const pct = (n) => (inflow > 0 ? Math.round((n / inflow) * 1000) / 10 : 0);

    res.status(200).json({
      success: true,
      data: {
        inflow: { total: inflow, referrals: inflowRows[0]?.count || 0 },
        outflow: {
          total: Math.round(outflow * 100) / 100,
          direct: byType[COMMISSION_TYPES.DIRECT] || 0,
          matching: byType[COMMISSION_TYPES.MATCHING] || 0,
          reversals: byType[COMMISSION_TYPES.REVERSAL] || 0,
          percentOfInflow: pct(outflow)
        },
        // Already earned, not yet paid.
        committed: {
          openCarry,
          payableNow: committed,
          membersHoldingCarry: carryRows[0]?.members || 0,
          percentOfInflow: pct(committed)
        },
        totalExposure: {
          total: Math.round((outflow + committed) * 100) / 100,
          percentOfInflow: pct(outflow + committed)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 7. POST /api/commissions/admin/reverse/:ledgerId
// ---------------------------------------------------------------------------
exports.reverseCommission = async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A reason is required to reverse a commission payment.'
      });
    }

    const { original, reversal } = await reverseRow(req.params.ledgerId, { reason });

    await record(req, {
      action: ACTIONS.COMMISSION_REVERSED,
      targetType: 'CommissionLedger',
      target: original._id,
      targetCode: original.beneficiaryCode,
      before: { type: original.type, amount: original.amount },
      after: { reversalId: reversal._id, amount: reversal.amount },
      note: reason
    });

    res.status(201).json({
      success: true,
      message: `Reversed ${original.amount} from ${original.beneficiaryCode}.`,
      data: reversal
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

exports.ROLES = ROLES;
