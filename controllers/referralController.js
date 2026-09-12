const Referral = require('../models/Referral');
const Associate = require('../models/Associate');
const { nextReferralNo, nextInvoiceNo } = require('../utils/codes');
const { record, ACTIONS } = require('../services/auditService');
const { parsePayment, paymentFields, receiverFields } = require('../services/referralService');
const { placeExisting } = require('../services/placementService');
const { withTransaction } = require('../utils/transaction');
const {
  ROLES,
  STATUSES,
  TIER_LABELS,
  POSITIONS,
  TREE_STATUSES,
  REFERRAL_STATUSES
} = require('../config/constants');

// Most referrals are raised by POST /api/associates/register when the admin
// picks a sponsor. POST /api/referrals covers members who were registered
// without one.

// Shape used by both dashboards.
const toInvoice = (referral) => ({
  _id: referral._id,
  invoiceNo: referral.invoiceNo,
  referralNo: referral.referralNo,
  issuedAt: referral.createdAt,
  issuedBy: referral.issuedBy?.fullName || null,
  // The sponsor — who paid for the member and gets the referral credit.
  issuedTo: {
    _id: referral.issuedTo?._id || referral.issuedTo,
    name: referral.issuedTo?.fullName || null,
    memberCode: referral.issuedToCode
  },
  // The referred member.
  member: {
    _id: referral.member?._id || referral.member,
    name: referral.member?.fullName || referral.memberName || null,
    memberCode: referral.memberCode,
    treeStatus: referral.member?.treeStatus || null
  },
  tier: referral.tier,
  tierLabel: TIER_LABELS[referral.tier],

  // Money received FROM the sponsor. Recorded only — never a payout.
  amountPaid: referral.amountPaid,
  payment: {
    mode: referral.paymentMode || null,
    reference: referral.paymentRef || '',
    receivedOn: referral.receivedOn,
    receivedBy: referral.receivedBy
      ? { _id: referral.receivedBy, name: referral.receivedByName, memberCode: referral.receivedByCode }
      : null
  },

  status: referral.status,

  // How the member got into the tree, once they did.
  usedAt: referral.usedAt,
  placement: referral.usedAt
    ? {
        by: referral.placedBy,
        under: referral.placedUnderCode,
        position: referral.placedPosition
      }
    : null,

  cancelledAt: referral.cancelledAt,
  cancelReason: referral.cancelReason || '',
  readAt: referral.readAt,
  notes: referral.notes || ''
});

const populateAll = (query) =>
  query
    .populate('issuedTo', 'memberCode fullName email phone')
    .populate('issuedBy', 'fullName email')
    .populate('member', 'memberCode fullName treeStatus');

// ---------------------------------------------------------------------------
// POST /api/referrals  (admin)
//
// Gives an already-registered, unsponsored member a sponsor and records what
// the sponsor paid. No PIN: with a leg the admin places the member under the
// sponsor now (spillover applies); without one the sponsor places them from
// their portal, choosing the parent and leg.
// ---------------------------------------------------------------------------
exports.createReferral = async (req, res, next) => {
  try {
    const { member: memberId, issuedTo, position } = req.body;

    if (!memberId) {
      return res.status(400).json({ success: false, message: 'member (the referred associate) is required.' });
    }
    if (!issuedTo) {
      return res.status(400).json({ success: false, message: 'issuedTo (the sponsor) is required.' });
    }
    if (String(memberId) === String(issuedTo)) {
      return res.status(400).json({ success: false, message: 'An associate cannot sponsor themselves.' });
    }
    if (position && ![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
      return res.status(400).json({ success: false, message: 'position must be "Left" or "Right".' });
    }

    const payment = await parsePayment(req.body);

    // --- The sponsor (who paid) ------------------------------------------
    const sponsor = await Associate.findById(issuedTo).select('memberCode fullName role status treeStatus');
    if (!sponsor) {
      return res.status(404).json({ success: false, message: 'Sponsor not found.' });
    }
    if (sponsor.role !== ROLES.ASSOCIATE) {
      return res.status(400).json({ success: false, message: 'Only an associate can be the sponsor.' });
    }
    if (sponsor.status !== STATUSES.APPROVED) {
      return res.status(400).json({ success: false, message: `Cannot make a ${sponsor.status} account a sponsor.` });
    }
    // A sponsor outside the tree has nowhere to place the member.
    if (sponsor.treeStatus === TREE_STATUSES.UNPLACED) {
      return res.status(400).json({
        success: false,
        message: `${sponsor.memberCode} is not in the tree yet, so they cannot sponsor anyone.`
      });
    }

    // --- The referred member (registered earlier, no sponsor) -------------
    const member = await Associate.findById(memberId).select('memberCode fullName role tier treeStatus sponsorId');
    if (!member) {
      return res.status(404).json({ success: false, message: 'Referred associate not found.' });
    }
    if (member.role !== ROLES.ASSOCIATE) {
      return res.status(400).json({ success: false, message: 'Only an associate can be referred.' });
    }
    if (member.sponsorId) {
      return res.status(400).json({ success: false, message: `${member.memberCode} already has a sponsor.` });
    }
    if (member.treeStatus !== TREE_STATUSES.UNPLACED) {
      return res.status(400).json({
        success: false,
        message: `${member.memberCode} is already in the tree, so they cannot be referred.`
      });
    }

    // One live referral per member — two would let two sponsors both claim them.
    const existing = await Referral.findOne({
      member: member._id,
      status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] }
    }).select('referralNo');
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `${member.memberCode} already has referral ${existing.referralNo}.`
      });
    }

    // Minted outside the transaction so a retry reuses them.
    const referralNo = await nextReferralNo();
    const invoiceNo = await nextInvoiceNo();

    const { referral, parent } = await withTransaction(async (session) => {
      // Conditional on still having no sponsor, so two concurrent requests
      // can't both claim the same member.
      const linked = await Associate.findOneAndUpdate(
        { _id: member._id, sponsorId: null },
        { sponsorId: sponsor._id, sponsorMemberCode: sponsor.memberCode },
        { session }
      );
      if (!linked) {
        const err = new Error(`${member.memberCode} already has a sponsor.`);
        err.status = 409;
        throw err;
      }

      await Associate.findByIdAndUpdate(sponsor._id, { $inc: { directCount: 1 } }, { session });

      let placedUnder = null;
      if (position) {
        // Spillover starts at the sponsor, so the member lands in their downline.
        const placed = await placeExisting(
          {
            memberId: member._id,
            requestedParentId: sponsor._id,
            position,
            extra: { status: STATUSES.APPROVED }
          },
          session
        );
        placedUnder = placed.parent;
      }

      const [raised] = await Referral.create(
        [
          {
            referralNo,
            invoiceNo,
            ...paymentFields(payment),
            ...receiverFields(req.user),
            tier: member.tier,
            member: member._id,
            memberCode: member.memberCode,
            memberName: member.fullName,
            issuedTo: sponsor._id,
            issuedToCode: sponsor.memberCode,
            issuedBy: req.user._id,
            ...(placedUnder && {
              status: REFERRAL_STATUSES.USED,
              usedAt: new Date(),
              placedBy: 'admin',
              placedPosition: position,
              placedUnderCode: placedUnder.memberCode
            })
          }
        ],
        { session }
      );

      return { referral: raised, parent: placedUnder };
    });

    await record(req, {
      action: ACTIONS.REFERRAL_ISSUED,
      targetType: 'Referral',
      target: referral._id,
      targetCode: referral.referralNo,
      after: {
        invoiceNo: referral.invoiceNo,
        member: member.memberCode,
        sponsor: sponsor.memberCode,
        tier: member.tier,
        amountPaid: payment.amountPaid,
        paymentMode: payment.paymentMode,
        paymentRef: payment.paymentRef,
        receivedOn: payment.receivedOn,
        receivedBy: req.user.fullName,
        placedByAdmin: Boolean(parent)
      }
    });

    if (parent) {
      await record(req, {
        action: ACTIONS.MEMBER_PLACED,
        targetType: 'Associate',
        target: member._id,
        targetCode: member.memberCode,
        after: { placedBy: 'admin', placedUnder: parent.memberCode, position }
      });
    }

    const populated = await populateAll(Referral.findById(referral._id));

    return res.status(201).json({
      success: true,
      message: parent
        ? `Referral created and ${member.memberCode} placed under ${parent.memberCode} (${position} leg).`
        : `Referral created. ${sponsor.fullName} can now place ${member.memberCode} from their portal.`,
      placement: parent
        ? { placedUnder: parent.memberCode, position, spilledOver: String(parent._id) !== String(sponsor._id) }
        : null,
      data: toInvoice(populated)
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/referrals  (admin)  — all referrals, filterable
// GET /api/referrals/mine (associate) — only referrals where the caller is sponsor
// ---------------------------------------------------------------------------
const listReferrals = async (req, res, next, forcedIssuedTo = null) => {
  try {
    const { status, tier, issuedTo, search, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));

    const filter = {};
    if (forcedIssuedTo) filter.issuedTo = forcedIssuedTo;
    else if (issuedTo) filter.issuedTo = issuedTo;

    if (status) filter.status = status;
    if (tier) filter.tier = tier;
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { referralNo: { $regex: safe, $options: 'i' } },
        { invoiceNo: { $regex: safe, $options: 'i' } },
        { issuedToCode: { $regex: safe, $options: 'i' } },
        { memberCode: { $regex: safe, $options: 'i' } }
      ];
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    // Members still waiting for placement sort oldest-first, so the ones left
    // longest stay visible instead of buried under recent activity.
    const sort = status === REFERRAL_STATUSES.UNUSED ? { createdAt: 1 } : { createdAt: -1 };

    const [items, total] = await Promise.all([
      populateAll(Referral.find(filter)).sort(sort).skip((page - 1) * limit).limit(limit),
      Referral.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      count: items.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      data: items.map(toInvoice)
    });
  } catch (error) {
    next(error);
  }
};

// `forcedIssuedTo` is what scopes an associate to their own referrals — it must
// stay the LAST argument, after `next`, or the scope silently disappears.
exports.listReferrals = (req, res, next) => listReferrals(req, res, next, null);
exports.myReferrals = (req, res, next) => listReferrals(req, res, next, req.user._id);

// ---------------------------------------------------------------------------
// GET /api/referrals/summary — dashboard counts, scoped by role.
// ---------------------------------------------------------------------------
exports.getSummary = async (req, res, next) => {
  try {
    const match = req.user.role === ROLES.ADMIN ? {} : { issuedTo: req.user._id };

    const grouped = await Referral.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amountPaid' } } }
    ]);

    const summary = { unused: 0, used: 0, cancelled: 0, totalAmount: 0, unusedAmount: 0 };
    for (const row of grouped) {
      if (summary[row._id] !== undefined) summary[row._id] = row.count;
      summary.totalAmount += row.amount;
      if (row._id === REFERRAL_STATUSES.UNUSED) summary.unusedAmount = row.amount;
    }

    // Unread, not-yet-placed referrals drive the "new referral" badge.
    summary.unread = await Referral.countDocuments({
      ...match,
      readAt: null,
      status: REFERRAL_STATUSES.UNUSED
    });

    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/referrals/:id/invoice — admin, or the sponsor it belongs to.
// ---------------------------------------------------------------------------
exports.getInvoice = async (req, res, next) => {
  try {
    const referral = await populateAll(Referral.findById(req.params.id));
    if (!referral) return res.status(404).json({ success: false, message: 'Referral not found.' });

    const isOwner = String(referral.issuedTo?._id || referral.issuedTo) === String(req.user._id);
    if (req.user.role !== ROLES.ADMIN && !isOwner) {
      return res.status(403).json({ success: false, message: 'This referral was not issued to you.' });
    }

    return res.status(200).json({ success: true, data: toInvoice(referral) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// POST /api/referrals/:id/read — clears the dashboard badge for the sponsor.
// ---------------------------------------------------------------------------
exports.markRead = async (req, res, next) => {
  try {
    const referral = await Referral.findOneAndUpdate(
      { _id: req.params.id, issuedTo: req.user._id, readAt: null },
      { readAt: new Date() },
      { new: true }
    );
    if (!referral) {
      return res.status(404).json({ success: false, message: 'Referral not found, not yours, or already read.' });
    }
    return res.status(200).json({ success: true, message: 'Marked as read.' });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/referrals/:id/cancel  (admin) — voids the payment record of a
// member who has not been placed yet.
// ---------------------------------------------------------------------------
exports.cancelReferral = async (req, res, next) => {
  try {
    // Conditional update: a member being placed at this moment must not have
    // their referral cancelled out from under the placement.
    const referral = await Referral.findOneAndUpdate(
      { _id: req.params.id, status: REFERRAL_STATUSES.UNUSED },
      {
        status: REFERRAL_STATUSES.CANCELLED,
        cancelledBy: req.user._id,
        cancelledAt: new Date(),
        cancelReason: req.body.reason || ''
      },
      { new: true }
    );

    if (!referral) {
      const exists = await Referral.findById(req.params.id).select('status');
      if (!exists) return res.status(404).json({ success: false, message: 'Referral not found.' });
      return res.status(400).json({
        success: false,
        message: `Only referrals whose member is not placed yet can be cancelled — this one is ${exists.status}.`
      });
    }

    await record(req, {
      action: ACTIONS.REFERRAL_CANCELLED,
      targetType: 'Referral',
      target: referral._id,
      targetCode: referral.referralNo,
      before: { status: REFERRAL_STATUSES.UNUSED },
      after: { status: REFERRAL_STATUSES.CANCELLED, amountPaid: referral.amountPaid },
      note: req.body.reason || ''
    });

    const populated = await populateAll(Referral.findById(referral._id));
    return res.status(200).json({
      success: true,
      message: 'Referral cancelled.',
      data: toInvoice(populated)
    });
  } catch (error) {
    next(error);
  }
};
