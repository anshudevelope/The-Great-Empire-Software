const mongoose = require('mongoose');
const Associate = require('../../models/Associate');
const PlotCommission = require('../../models/plots/Commission');
const PlotNetwork = require('../../models/plots/Network');
const PlotPayout = require('../../models/plots/Payout');
const PlotBooking = require('../../models/plots/Booking');
const { BOOKING_STATUSES } = require('../../config/plotConfig');
const { record } = require('../../services/auditService');
const { COMMISSION_TYPES } = require('../../config/constants');
const payoutService = require('../../services/plots/payoutService');
const { round2, httpError, assertId, pageOf, listResponse, searchFilter, PLOT_ACTIONS } = require('../../services/plots/helpers');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
// Zero-value rows are internal markers ("volume posted"), never shown.
const moneyRows = { amount: { $ne: 0 } };

// The plot ledger, newest first. Filter by associate, type, booking, paid state.
exports.listLedger = async (req, res, next) => {
  try {
    const filter = { ...moneyRows };
    if (req.query.associate) {
      assertId(req.query.associate, 'associate');
      filter.beneficiary = oid(req.query.associate);
    }
    if (req.query.booking) {
      assertId(req.query.booking, 'booking');
      filter.booking = oid(req.query.booking);
    }
    if (Object.values(COMMISSION_TYPES).includes(req.query.type)) filter.type = req.query.type;
    if (req.query.paid === 'true') filter.payout = { $ne: null };
    if (req.query.paid === 'false') filter.payout = null;
    if (req.query.search) Object.assign(filter, searchFilter(req.query.search, ['beneficiaryCode', 'bookingCode', 'sourceAssociateCode']));

    const { page, limit, skip } = pageOf(req.query);
    const [rows, total, sums] = await Promise.all([
      PlotCommission.find(filter).populate('payout', 'payoutNo status').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PlotCommission.countDocuments(filter),
      PlotCommission.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            unpaid: { $sum: { $cond: [{ $eq: ['$payout', null] }, '$amount', 0] } }
          }
        }
      ])
    ]);
    return listResponse(res, {
      rows,
      total,
      page,
      limit,
      extra: { summary: { total: round2(sums[0]?.total || 0), unpaid: round2(sums[0]?.unpaid || 0) } }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Per associate: plot carry and leg volume (PlotNetwork) next to earned, paid
 * and unpaid commission (PlotCommission). Only associates with plot activity.
 */
exports.listSummary = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['memberCode']) };
    const [networks, total] = await Promise.all([
      PlotNetwork.find(filter).sort({ memberCode: 1 }).skip(skip).limit(limit).lean(),
      PlotNetwork.countDocuments(filter)
    ]);
    const ids = networks.map((n) => n.associate);

    const [names, money] = await Promise.all([
      Associate.find({ _id: { $in: ids } }).select('memberCode fullName').lean(),
      PlotCommission.aggregate([
        { $match: { beneficiary: { $in: ids }, ...moneyRows } },
        {
          $group: {
            _id: '$beneficiary',
            unpaid: { $sum: { $cond: [{ $eq: ['$payout', null] }, '$amount', 0] } },
            paid: { $sum: { $cond: [{ $ne: ['$payout', null] }, '$amount', 0] } }
          }
        }
      ])
    ]);
    const nameOf = new Map(names.map((a) => [String(a._id), a]));
    const moneyOf = new Map(money.map((m) => [String(m._id), m]));

    return listResponse(res, {
      rows: networks.map((n) => {
        const a = nameOf.get(String(n.associate));
        const m = moneyOf.get(String(n.associate)) || { unpaid: 0, paid: 0 };
        return {
          associate: n.associate,
          memberCode: a?.memberCode || n.memberCode,
          fullName: a?.fullName || '',
          carry: { left: round2(n.carryLeft), right: round2(n.carryRight) },
          volume: { left: round2(n.totalLeftVolume), right: round2(n.totalRightVolume) },
          earned: { direct: round2(n.directEarned), matching: round2(n.matchingEarned) },
          unpaid: round2(m.unpaid),
          paid: round2(m.paid)
        };
      }),
      total,
      page,
      limit
    });
  } catch (error) {
    next(error);
  }
};

// Live plot sales in one leg: those credited to anyone in the leg headed by
// `childId`, plus the associate's own sales placed directly in that leg.
const legSales = async (associateId, childId, side) => {
  const live = { status: { $ne: BOOKING_STATUSES.CANCELLED } };
  const own = await PlotBooking.countDocuments({ ...live, associate: associateId, leg: side });
  if (!childId) return own;
  const members = [childId, ...(await Associate.find({ ancestors: childId }).distinct('_id'))];
  return own + (await PlotBooking.countDocuments({ ...live, associate: { $in: members } }));
};

// One associate's plot position — for the associate detail / tree hover card.
exports.getAssociateSummary = async (req, res, next) => {
  try {
    assertId(req.params.id, 'associate');
    const id = oid(req.params.id);
    const node = await Associate.findById(id).select('leftChild rightChild').lean();
    if (!node) throw httpError('Associate not found.', 404);
    const [network, money, salesLeft, salesRight] = await Promise.all([
      PlotNetwork.findOne({ associate: id }).lean(),
      PlotCommission.aggregate([
        { $match: { beneficiary: id, ...moneyRows } },
        {
          $group: {
            _id: null,
            unpaid: { $sum: { $cond: [{ $eq: ['$payout', null] }, '$amount', 0] } },
            paid: { $sum: { $cond: [{ $ne: ['$payout', null] }, '$amount', 0] } }
          }
        }
      ]),
      legSales(id, node.leftChild, 'Left'),
      legSales(id, node.rightChild, 'Right')
    ]);
    res.status(200).json({
      success: true,
      data: {
        carry: { left: round2(network?.carryLeft), right: round2(network?.carryRight) },
        volume: { left: round2(network?.totalLeftVolume), right: round2(network?.totalRightVolume) },
        ratedVolume: { left: round2(network?.totalLeftRatedVolume), right: round2(network?.totalRightRatedVolume) },
        sales: { left: salesLeft, right: salesRight },
        earned: { direct: round2(network?.directEarned), matching: round2(network?.matchingEarned) },
        unpaid: round2(money[0]?.unpaid || 0),
        paid: round2(money[0]?.paid || 0)
      }
    });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// Plot payouts
// ===========================================================================
exports.listPayouts = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const [rows, total] = await Promise.all([
      PlotPayout.find(filter).select('-lines').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PlotPayout.countDocuments(filter)
    ]);
    return listResponse(res, { rows, total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.getPayout = async (req, res, next) => {
  try {
    assertId(req.params.id, 'payout');
    const payout = await PlotPayout.findById(req.params.id).lean();
    if (!payout) throw httpError('Plot payout not found.', 404);
    res.status(200).json({ success: true, data: payout });
  } catch (error) {
    next(error);
  }
};

exports.generatePayout = async (req, res, next) => {
  try {
    const payout = await payoutService.generateDraft({ periodEnd: req.body.periodEnd, actor: req.user, note: req.body.note || '' });
    await record(req, { action: PLOT_ACTIONS.PAYOUT_GENERATED, targetType: 'PlotPayout', target: payout._id, targetCode: payout.payoutNo, after: payout.totals });
    res.status(201).json({ success: true, message: `Draft ${payout.payoutNo} generated.`, data: payout });
  } catch (error) {
    next(error);
  }
};

exports.finalizePayout = async (req, res, next) => {
  try {
    assertId(req.params.id, 'payout');
    const payout = await payoutService.finalize(req.params.id, req.user);
    await record(req, { action: PLOT_ACTIONS.PAYOUT_FINALIZED, targetType: 'PlotPayout', target: payout._id, targetCode: payout.payoutNo, after: payout.totals });
    res.status(200).json({ success: true, message: `${payout.payoutNo} finalized.`, data: payout });
  } catch (error) {
    next(error);
  }
};

exports.cancelPayout = async (req, res, next) => {
  try {
    assertId(req.params.id, 'payout');
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw httpError('A reason for cancelling is required.');
    const payout = await payoutService.cancel(req.params.id, req.user, reason);
    await record(req, { action: PLOT_ACTIONS.PAYOUT_CANCELLED, targetType: 'PlotPayout', target: payout._id, targetCode: payout.payoutNo, note: reason });
    res.status(200).json({ success: true, message: `${payout.payoutNo} cancelled.`, data: payout });
  } catch (error) {
    next(error);
  }
};

exports.discardPayout = async (req, res, next) => {
  try {
    assertId(req.params.id, 'payout');
    await payoutService.discard(req.params.id);
    await record(req, { action: PLOT_ACTIONS.PAYOUT_DISCARDED, targetType: 'PlotPayout', target: req.params.id });
    res.status(200).json({ success: true, message: 'Draft discarded.' });
  } catch (error) {
    next(error);
  }
};
