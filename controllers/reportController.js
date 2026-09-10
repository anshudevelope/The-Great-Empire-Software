const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const { resolveScopeRoot, buildScopedFilter, parsePaging } = require('../services/reportService');
const { streamCsv } = require('../utils/csv');
const { ROLES, TIERS, TIER_LABELS, REFERRAL_STATUSES } = require('../config/constants');

const REPORT_FIELDS =
  'memberCode fullName email phone status tier position depth directCount ' +
  'sponsorId sponsorMemberCode treeStatus parentId ancestors createdAt';

const rowOf = (a, parentCode = null) => ({
  memberCode: a.memberCode,
  fullName: a.fullName,
  email: a.email,
  phone: a.phone,
  status: a.status,
  tier: a.tier,
  tierLabel: TIER_LABELS[a.tier] || null,
  position: a.position,
  depth: a.depth,
  directCount: a.directCount,
  sponsorMemberCode: a.sponsorMemberCode,
  treeStatus: a.treeStatus,
  placedUnderCode: parentCode,
  isSpillover: Boolean(a.sponsorId && a.parentId && String(a.sponsorId) !== String(a.parentId)),
  joinedAt: a.createdAt
});

const CSV_COLUMNS = [
  { header: 'Member Code', value: (a) => a.memberCode },
  { header: 'Name', value: (a) => a.fullName },
  { header: 'Email', value: (a) => a.email },
  { header: 'Phone', value: (a) => a.phone },
  { header: 'Status', value: (a) => a.status },
  { header: 'Tier', value: (a) => a.tier },
  { header: 'Product', value: (a) => TIER_LABELS[a.tier] || '' },
  { header: 'Leg', value: (a) => a.position || '' },
  { header: 'Depth', value: (a) => a.depth },
  { header: 'Directs', value: (a) => a.directCount },
  { header: 'Sponsored By', value: (a) => a.sponsorMemberCode || '' },
  { header: 'Joined', value: (a) => a.createdAt }
];

// ---------------------------------------------------------------------------
// GET /api/reports/downline[/:id]
// Everyone beneath the scope root. One indexed query on `ancestors`.
// Add ?format=csv to stream the whole result set instead of a page.
// ---------------------------------------------------------------------------
exports.getDownline = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    const filter = buildScopedFilter(root, req.query);

    if (req.query.format === 'csv') {
      const cursor = Associate.find(filter).select(REPORT_FIELDS).sort({ depth: 1, createdAt: 1 }).lean().cursor();
      const name = `downline-${root ? root.memberCode : 'all'}-${new Date().toISOString().slice(0, 10)}.csv`;
      return streamCsv(res, name, CSV_COLUMNS, cursor);
    }

    const { page, limit, skip, sort } = parsePaging(req.query);
    const [rows, total] = await Promise.all([
      Associate.find(filter).select(REPORT_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
      Associate.countDocuments(filter)
    ]);

    // Resolve placement parents in one query, so the report can show that a
    // direct actually sits somewhere else in the tree.
    const parentIds = rows.map((r) => r.parentId).filter(Boolean);
    const parents = await Associate.find({ _id: { $in: parentIds } }).select('memberCode').lean();
    const parentCode = new Map(parents.map((p) => [String(p._id), p.memberCode]));

    return res.status(200).json({
      success: true,
      scope: root ? { memberCode: root.memberCode, fullName: root.fullName } : { memberCode: null, fullName: 'All members' },
      count: rows.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: rows.map((a) => rowOf(a, a.parentId ? parentCode.get(String(a.parentId)) || null : null))
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/directs[/:id]  — the REFERRAL side: who this member
// personally introduced, regardless of where they were placed.
// ---------------------------------------------------------------------------
exports.getDirects = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    if (!root) {
      return res.status(400).json({ success: false, message: 'A member is required for a directs report.' });
    }

    const filter = { sponsorId: root._id };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.tier) filter.tier = req.query.tier;

    if (req.query.format === 'csv') {
      const cursor = Associate.find(filter).select(REPORT_FIELDS).sort({ createdAt: 1 }).lean().cursor();
      return streamCsv(res, `directs-${root.memberCode}.csv`, CSV_COLUMNS, cursor);
    }

    const rows = await Associate.find(filter).select(REPORT_FIELDS).sort({ createdAt: 1 }).lean();
    const parents = await Associate.find({ _id: { $in: rows.map((r) => r.parentId).filter(Boolean) } })
      .select('memberCode').lean();
    const parentCode = new Map(parents.map((p) => [String(p._id), p.memberCode]));

    return res.status(200).json({
      success: true,
      scope: { memberCode: root.memberCode, fullName: root.fullName },
      count: rows.length,
      data: rows.map((a) => rowOf(a, a.parentId ? parentCode.get(String(a.parentId)) || null : null))
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/levels[/:id]  — how many members sit at each level below
// the scope root. Aggregated in the database, not counted in Node.
// ---------------------------------------------------------------------------
exports.getLevels = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    const filter = buildScopedFilter(root, req.query);

    const grouped = await Associate.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$depth',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          tierI: { $sum: { $cond: [{ $eq: ['$tier', TIERS.ONE] }, 1, 0] } },
          tierII: { $sum: { $cond: [{ $eq: ['$tier', TIERS.TWO] }, 1, 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const baseDepth = root ? root.depth : -1;

    return res.status(200).json({
      success: true,
      scope: root ? { memberCode: root.memberCode, fullName: root.fullName } : { memberCode: null, fullName: 'All members' },
      data: grouped.map((g) => ({
        // Relative level is what a member cares about ("level 3 under me"),
        // absolute depth is what's stored.
        level: g._id - baseDepth,
        absoluteDepth: g._id,
        total: g.total,
        active: g.active,
        tierI: g.tierI,
        tierII: g.tierII
      })),
      totals: grouped.reduce(
        (acc, g) => ({
          members: acc.members + g.total,
          active: acc.active + g.active,
          tierI: acc.tierI + g.tierI,
          tierII: acc.tierII + g.tierII
        }),
        { members: 0, active: 0, tierI: 0, tierII: 0 }
      )
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/legs[/:id]  — left vs right leg size. This is the shape a
// future binary-payout engine consumes (weaker leg, carry-forward).
// ---------------------------------------------------------------------------
exports.getLegs = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    if (!root) {
      return res.status(400).json({ success: false, message: 'A member is required for a leg report.' });
    }

    const legStats = async (childId) => {
      if (!childId) return { rootCode: null, total: 0, active: 0, tierI: 0, tierII: 0 };

      const [head, agg] = await Promise.all([
        Associate.findById(childId).select('memberCode').lean(),
        Associate.aggregate([
          { $match: { $or: [{ _id: childId }, { ancestors: childId }], role: ROLES.ASSOCIATE } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
              tierI: { $sum: { $cond: [{ $eq: ['$tier', TIERS.ONE] }, 1, 0] } },
              tierII: { $sum: { $cond: [{ $eq: ['$tier', TIERS.TWO] }, 1, 0] } }
            }
          }
        ])
      ]);

      const s = agg[0] || { total: 0, active: 0, tierI: 0, tierII: 0 };
      return { rootCode: head?.memberCode || null, total: s.total, active: s.active, tierI: s.tierI, tierII: s.tierII };
    };

    const [left, right] = await Promise.all([legStats(root.leftChild), legStats(root.rightChild)]);

    return res.status(200).json({
      success: true,
      scope: { memberCode: root.memberCode, fullName: root.fullName },
      data: {
        left,
        right,
        // Pairing in a binary plan pays on the weaker leg; the difference is
        // what carries forward. Reported here, not paid — no payout engine yet.
        matched: Math.min(left.total, right.total),
        carryLeft: Math.max(0, left.total - right.total),
        carryRight: Math.max(0, right.total - left.total),
        weakerLeg: left.total === right.total ? 'Balanced' : (left.total < right.total ? 'Left' : 'Right')
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/tiers[/:id]  — Tier I (Insurance) vs Tier II (Plots) split.
// ---------------------------------------------------------------------------
exports.getTierSplit = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    const filter = buildScopedFilter(root, req.query);

    const grouped = await Associate.aggregate([
      { $match: filter },
      { $group: { _id: { tier: '$tier', status: '$status' }, count: { $sum: 1 } } }
    ]);

    const data = {};
    for (const tier of Object.values(TIERS)) {
      data[tier] = { label: TIER_LABELS[tier], total: 0, byStatus: {} };
    }
    for (const g of grouped) {
      const tier = g._id.tier;
      if (!data[tier]) continue;
      data[tier].total += g.count;
      data[tier].byStatus[g._id.status] = g.count;
    }

    return res.status(200).json({
      success: true,
      scope: root ? { memberCode: root.memberCode, fullName: root.fullName } : { memberCode: null, fullName: 'All members' },
      data
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/growth[/:id]  — joins per month.
// ---------------------------------------------------------------------------
exports.getGrowth = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    const filter = buildScopedFilter(root, req.query);

    const grouped = await Associate.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          total: { $sum: 1 },
          tierI: { $sum: { $cond: [{ $eq: ['$tier', TIERS.ONE] }, 1, 0] } },
          tierII: { $sum: { $cond: [{ $eq: ['$tier', TIERS.TWO] }, 1, 0] } }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    let running = 0;
    return res.status(200).json({
      success: true,
      scope: root ? { memberCode: root.memberCode, fullName: root.fullName } : { memberCode: null, fullName: 'All members' },
      data: grouped.map((g) => {
        running += g.total;
        return {
          period: `${g._id.year}-${String(g._id.month).padStart(2, '0')}`,
          joined: g.total,
          tierI: g.tierI,
          tierII: g.tierII,
          cumulative: running
        };
      })
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/referrals  — voucher / money-received report.
//
// amountPaid is money the associate PAID IN, never a payout. Unused vouchers
// are an open liability: someone has paid and has not yet got a member out of
// it, so they are reported separately and aged.
// ---------------------------------------------------------------------------
exports.getReferralReport = async (req, res, next) => {
  try {
    const match = req.user.role === ROLES.ADMIN ? {} : { issuedTo: req.user._id };

    if (req.query.tier) match.tier = req.query.tier;
    if (req.query.status) match.status = req.query.status;
    if (req.query.from || req.query.to) {
      match.receivedOn = {};
      if (req.query.from) match.receivedOn.$gte = new Date(req.query.from);
      if (req.query.to) match.receivedOn.$lte = new Date(req.query.to);
    }

    if (req.query.format === 'csv') {
      const cursor = Referral.find(match).sort({ receivedOn: -1 }).lean().cursor();
      return streamCsv(
        res,
        `referrals-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          { header: 'Invoice No', value: (r) => r.invoiceNo },
          { header: 'Referral No', value: (r) => r.referralNo },
          { header: 'Issued To', value: (r) => r.issuedToCode },
          { header: 'Tier', value: (r) => r.tier },
          { header: 'Product', value: (r) => TIER_LABELS[r.tier] || '' },
          { header: 'Amount Paid', value: (r) => r.amountPaid },
          { header: 'Payment Mode', value: (r) => r.paymentMode || '' },
          { header: 'Payment Ref', value: (r) => r.paymentRef || '' },
          { header: 'Received On', value: (r) => r.receivedOn },
          { header: 'Received By', value: (r) => r.receivedByName || '' },
          { header: 'Status', value: (r) => r.status },
          { header: 'Used By', value: (r) => r.usedByCode || '' }
        ],
        cursor
      );
    }

    const [byStatus, byMode, aged] = await Promise.all([
      Referral.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 }, amountPaid: { $sum: '$amountPaid' } } }
      ]),
      Referral.aggregate([
        { $match: match },
        { $group: { _id: '$paymentMode', count: { $sum: 1 }, amountPaid: { $sum: '$amountPaid' } } },
        { $sort: { amountPaid: -1 } }
      ]),
      // Oldest unused first: vouchers never expire, so a stale one is money
      // collected long ago with nothing delivered against it.
      Referral.find({ ...match, status: REFERRAL_STATUSES.UNUSED })
        .sort({ receivedOn: 1 })
        .limit(20)
        .select('referralNo invoiceNo issuedToCode tier amountPaid receivedOn')
        .lean()
    ]);

    const summary = { unused: 0, used: 0, cancelled: 0 };
    let collected = 0;
    let openLiability = 0;
    for (const row of byStatus) {
      if (summary[row._id] !== undefined) summary[row._id] = row.count;
      collected += row.amountPaid;
      if (row._id === REFERRAL_STATUSES.UNUSED) openLiability = row.amountPaid;
    }

    const now = Date.now();
    return res.status(200).json({
      success: true,
      data: {
        counts: summary,
        totalCollected: collected,
        openLiability,
        byStatus: byStatus.map((r) => ({ status: r._id, count: r.count, amountPaid: r.amountPaid })),
        byPaymentMode: byMode.map((r) => ({ mode: r._id || 'Unrecorded', count: r.count, amountPaid: r.amountPaid })),
        agedUnused: aged.map((r) => ({
          referralNo: r.referralNo,
          invoiceNo: r.invoiceNo,
          issuedTo: r.issuedToCode,
          tier: r.tier,
          amountPaid: r.amountPaid,
          receivedOn: r.receivedOn,
          ageDays: Math.floor((now - new Date(r.receivedOn).getTime()) / 86400000)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/reports/pending  — registrations awaiting approval.
// ---------------------------------------------------------------------------
exports.getPending = async (req, res, next) => {
  try {
    const root = await resolveScopeRoot(req.user, req.params.id);
    const filter = buildScopedFilter(root, { ...req.query, status: 'pending' });

    const rows = await Associate.find(filter).select(REPORT_FIELDS).sort({ createdAt: 1 }).lean();

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map((a) => rowOf(a))
    });
  } catch (error) {
    next(error);
  }
};
