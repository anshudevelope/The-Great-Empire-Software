const bcrypt = require('bcryptjs');
const Referral = require('../models/Referral');
const Associate = require('../models/Associate');
const { nextReferralNo, nextInvoiceNo, generatePin } = require('../utils/codes');
const { assertRedeemable } = require('../services/referralService');
const { record, ACTIONS } = require('../services/auditService');
const { withTransaction } = require('../utils/transaction');
const { placeExisting } = require('../services/placementService');
const {
  ROLES,
  STATUSES,
  TIERS,
  TIER_LABELS,
  POSITIONS,
  TREE_STATUSES,
  REFERRAL_STATUSES,
  PAYMENT_MODES
} = require('../config/constants');

// Shape used by both dashboards. Never includes the PIN.
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
    memberCode: referral.issuedToCode,
    sponsorCode: referral.issuedToSponsorCode || referral.issuedTo?.sponsorCode || null
  },
  // The referred member — created before the referral, not by it.
  member: {
    _id: referral.member?._id || referral.member,
    name: referral.member?.fullName || referral.memberName || null,
    memberCode: referral.memberCode,
    treeStatus: referral.member?.treeStatus || null
  },
  tier: referral.tier,
  tierLabel: TIER_LABELS[referral.tier],

  // Money received FROM the associate. Recorded only — never a payout.
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
  pinHint: referral.pinLast2 ? `••••${referral.pinLast2}` : null,

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
    .populate('issuedTo', 'memberCode sponsorCode fullName email phone')
    .populate('issuedBy', 'fullName email')
    .populate('member', 'memberCode fullName treeStatus');

// ---------------------------------------------------------------------------
// POST /api/referrals  (admin)
//
// Generates a voucher. This is the ONLY time the plaintext PIN exists outside
// the admin's screen — it is hashed on save and can never be recovered. If the
// admin loses it, the voucher must be cancelled and reissued.
// ---------------------------------------------------------------------------
exports.createReferral = async (req, res, next) => {
  try {
    const {
      member: memberId,
      issuedTo,
      amountPaid,
      notes,
      paymentMode,
      paymentRef,
      receivedOn,
      receivedBy,
      // Optional: admin can fill the tree slot right here instead of leaving it
      // to the sponsor.
      position
    } = req.body;

    if (!memberId) {
      return res.status(400).json({ success: false, message: 'member (the referred associate) is required.' });
    }
    if (!issuedTo) {
      return res.status(400).json({ success: false, message: 'issuedTo (the sponsor) is required.' });
    }
    if (String(memberId) === String(issuedTo)) {
      return res.status(400).json({ success: false, message: 'An associate cannot sponsor themselves.' });
    }

    const parsedAmount = Number(amountPaid);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ success: false, message: 'amountPaid must be a non-negative number.' });
    }

    // Payment detail is entirely optional — but if a mode is given it must be
    // a known one, so the field stays reportable.
    if (paymentMode && !PAYMENT_MODES.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: `paymentMode must be one of: ${PAYMENT_MODES.join(', ')}.`
      });
    }

    let receivedOnDate = new Date();
    if (receivedOn) {
      receivedOnDate = new Date(receivedOn);
      if (Number.isNaN(receivedOnDate.getTime())) {
        return res.status(400).json({ success: false, message: 'receivedOn is not a valid date.' });
      }
    }
    // `receivedOn` is a DATE, not a timestamp — the form only ever collects a
    // day. Left un-normalised, a value defaulted to `new Date()` carries a time
    // and sorts above one entered on the form for the same day (stored at
    // midnight), so the invoice register ends up in an order that looks random.
    // Flattening to midnight makes same-day entries tie, letting createdAt
    // order them newest-first.
    receivedOnDate.setUTCHours(0, 0, 0, 0);

    // Resolved to a snapshot so the receipt keeps its wording even if this
    // person is later renamed or removed.
    let receiver = null;
    if (receivedBy) {
      receiver = await Associate.findById(receivedBy).select('memberCode fullName');
      if (!receiver) {
        return res.status(404).json({ success: false, message: 'receivedBy: person not found.' });
      }
    }

    // --- The sponsor (who paid) ------------------------------------------
    const sponsor = await Associate.findById(issuedTo).select('memberCode sponsorCode fullName role status');
    if (!sponsor) {
      return res.status(404).json({ success: false, message: 'Sponsor not found.' });
    }
    if (sponsor.role !== ROLES.ASSOCIATE) {
      return res.status(400).json({ success: false, message: 'Only an associate can be the sponsor.' });
    }
    if (sponsor.status !== STATUSES.APPROVED) {
      return res.status(400).json({
        success: false,
        message: `Cannot make a ${sponsor.status} account a sponsor.`
      });
    }

    // --- The referred member (created earlier, usually unplaced) ----------
    const member = await Associate.findById(memberId).select('memberCode fullName role tier treeStatus sponsorId');
    if (!member) {
      return res.status(404).json({ success: false, message: 'Referred associate not found.' });
    }
    if (member.role !== ROLES.ASSOCIATE) {
      return res.status(400).json({ success: false, message: 'Only an associate can be referred.' });
    }
    if (member.sponsorId) {
      return res.status(400).json({
        success: false,
        message: `${member.memberCode} already has a sponsor.`
      });
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

    if (position && ![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
      return res.status(400).json({ success: false, message: 'position must be "Left" or "Right".' });
    }

    const pin = generatePin();
    const referral = await Referral.create({
      referralNo: await nextReferralNo(),
      invoiceNo: await nextInvoiceNo(),
      pinHash: await bcrypt.hash(pin, await bcrypt.genSalt(10)),
      pinLast2: pin.slice(-2),
      amountPaid: parsedAmount,
      paymentMode: paymentMode || null,
      paymentRef: paymentRef || '',
      receivedOn: receivedOnDate,
      receivedBy: receiver ? receiver._id : null,
      receivedByName: receiver ? receiver.fullName : '',
      receivedByCode: receiver ? receiver.memberCode || '' : '',
      // Snapshot from the member — the tier is theirs, fixed at their creation.
      tier: member.tier,
      member: member._id,
      memberCode: member.memberCode,
      memberName: member.fullName,
      issuedTo: sponsor._id,
      issuedToCode: sponsor.memberCode,
      issuedToSponsorCode: sponsor.sponsorCode || null,
      issuedBy: req.user._id,
      notes: notes || ''
    });

    // --- Optional: admin places the member straight away -------------------
    // Offered because the sponsor may not be able to do it themselves. When
    // skipped, the referral stays 'unused' and the sponsor places the member
    // with the referral number + PIN.
    let placement = null;
    if (position) {
      try {
        placement = await withTransaction(async (session) => {
          const { member: placedMember, parent } = await placeExisting(
            { memberId: member._id, requestedParentId: sponsor._id, position },
            session
          );

          placedMember.sponsorId = sponsor._id;
          placedMember.sponsorMemberCode = sponsor.memberCode;
          placedMember.sponsorSponsorCode = sponsor.sponsorCode || null;
          placedMember.status = STATUSES.APPROVED;
          await placedMember.save({ session });

          await Referral.findByIdAndUpdate(
            referral._id,
            {
              status: REFERRAL_STATUSES.USED,
              usedAt: new Date(),
              placedBy: 'admin',
              placedPosition: position,
              placedUnderCode: parent.memberCode
            },
            { session }
          );

          await Associate.findByIdAndUpdate(sponsor._id, { $inc: { directCount: 1 } }, { session });

          return { placedUnder: parent.memberCode, position, spilledOver: String(parent._id) !== String(sponsor._id) };
        });
      } catch (placementError) {
        // The referral itself is already saved and valid — surface the failure
        // but don't lose the payment record. The sponsor can still redeem.
        return res.status(placementError.status || 409).json({
          success: false,
          message: `Referral ${referral.referralNo} was created, but placement failed: ${placementError.message}`,
          pin,
          data: toInvoice(await populateAll(Referral.findById(referral._id)))
        });
      }
    }

    const populated = await populateAll(Referral.findById(referral._id));

    // Money changed hands — record who issued it and against which payment.
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
        amountPaid: parsedAmount,
        paymentMode: paymentMode || null,
        paymentRef: paymentRef || '',
        receivedOn: receivedOnDate,
        receivedBy: receiver ? receiver.memberCode || receiver.fullName : null,
        placedByAdmin: Boolean(placement)
      }
    });

    return res.status(201).json({
      success: true,
      message: placement
        ? `Referral created and ${member.memberCode} placed under ${placement.placedUnder}.`
        : 'Referral created. Copy the PIN now — it cannot be shown again. The sponsor uses it to place this member in the tree.',
      pin, // shown exactly once, never retrievable afterwards
      placement,
      data: toInvoice(populated)
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/referrals  (admin)  — all vouchers, filterable
// GET /api/referrals/mine (associate) — only vouchers issued to the caller
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
      filter.$or = [
        { referralNo: { $regex: search, $options: 'i' } },
        { invoiceNo: { $regex: search, $options: 'i' } },
        { issuedToCode: { $regex: search, $options: 'i' } }
      ];
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    // Vouchers never expire, so an unused one is an open liability that someone
    // already paid for. Sorting unused oldest-first keeps stale ones visible
    // instead of buried under recent activity.
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

// `forcedIssuedTo` is what scopes an associate to their own vouchers — it must
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

    // Unread, unused vouchers drive the "you have a new referral" badge.
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
// GET /api/referrals/:id/invoice — admin, or the associate it was issued to.
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
// POST /api/referrals/:id/read — clears the dashboard badge for the recipient.
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
// POST /api/referrals/verify  (associate)
//
// Checks referralNo + PIN before the associate fills in the registration form.
// Verification alone changes nothing — the voucher is only consumed at
// redemption (Phase 3), atomically.
// ---------------------------------------------------------------------------
exports.verifyReferral = async (req, res, next) => {
  try {
    const { referralNo, pin } = req.body;

    // Shared with the redeem endpoint so the two checks can never drift apart.
    let referral;
    try {
      referral = await assertRedeemable(referralNo, pin, req.user._id);
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Referral verified.',
      data: {
        referralNo: referral.referralNo,
        invoiceNo: referral.invoiceNo,
        tier: referral.tier,
        tierLabel: TIER_LABELS[referral.tier],
        amountPaid: referral.amountPaid,
        // The sponsor is whoever holds this referral — the caller.
        sponsor: {
          _id: req.user._id,
          name: req.user.fullName,
          memberCode: req.user.memberCode
        },
        // Who will be placed. The member already exists, so the placement form
        // shows them rather than asking for their details again.
        member: {
          _id: referral.member,
          name: referral.memberName || null,
          memberCode: referral.memberCode
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/referrals/:id/cancel  (admin)
// ---------------------------------------------------------------------------
exports.cancelReferral = async (req, res, next) => {
  try {
    // Conditional update: a voucher being redeemed at this moment must not be
    // cancelled out from under the redemption.
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
        message: `Only unused referrals can be cancelled — this one is ${exists.status}.`
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
