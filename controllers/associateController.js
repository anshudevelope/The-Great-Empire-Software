const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const bcrypt = require('bcryptjs');
const { cloudinary } = require('../config/cloudinary');
const { nextMemberCode, nextReferralNo, nextInvoiceNo } = require('../utils/codes');
const { withTransaction } = require('../utils/transaction');
const { encrypt, decrypt } = require('../utils/secretBox');
const { record, ACTIONS } = require('../services/auditService');
const { parsePayment, paymentFields, markReferralPlaced } = require('../services/referralService');
const {
  resolveTreeTarget,
  detachFromParent,
  repathSubtree,
  createAndPlace,
  placeExisting,
  previewPlacement,
  claimSlot,
  childField,
  httpError
} = require('../services/placementService');
const {
  ROLES,
  STATUSES,
  TIERS,
  TIER_LABELS,
  POSITIONS,
  TREE_STATUSES,
  REFERRAL_STATUSES,
  ADMIN_UPDATABLE_FIELDS,
  SELF_UPDATABLE_FIELDS,
  pickAllowedFields
} = require('../config/constants');

// Matches the admin form's validation. Associates choosing their own password
// on /auth/change-password are held to the stricter rule there.
const MIN_ADMIN_PASSWORD_LENGTH = 6;

// Personal fields accepted for a new member. Structural fields (tier, sponsor,
// placement) are validated separately.
const MEMBER_DETAIL_FIELDS = [
  'title', 'fullName', 'fatherOrHusbandName', 'maritalStatus', 'gender',
  'phone', 'email', 'dob', 'age',
  'address', 'city', 'country', 'state', 'pinCode',
  'nomineeName', 'nomineeRelation', 'nomineeAge'
];

const collectUploads = (req) => {
  const profileImage = {};
  if (req.files?.profileImage?.[0]) {
    const file = req.files.profileImage[0];
    profileImage.url = file.path;
    profileImage.public_id = file.filename;
  }

  const documents = (req.files?.documents || []).map((file, index) => ({
    docType: req.body[`docType_${index}`] || 'KYC Document',
    url: file.path,
    public_id: file.filename
  }));

  return { profileImage, documents };
};

const assertUniqueContact = async ({ email, phone }) => {
  const existing = await Associate.findOne({ $or: [{ email }, { phone }] }).select('_id');
  if (existing) throw httpError('Email or Phone already registered.', 400);
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Does walking up the referral chain from `startId` reach `targetId`? Used to
// stop a sponsor change from closing a loop (A sponsors B, B sponsors A).
// Bounded, so corrupt data that already has a cycle can't hang the request.
const isInSponsorChain = async (startId, targetId) => {
  const seen = new Set();
  let current = startId;
  while (current && seen.size < 10000) {
    const key = String(current);
    if (key === String(targetId)) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    const node = await Associate.findById(current).select('sponsorId').lean();
    current = node ? node.sponsorId : null;
  }
  return false;
};

// Both copies travel together: the hash is what login checks, the encrypted
// copy is what the admin panel shows. Writing one without the other would make
// the panel lie about the password.
const passwordFields = async (plain) => ({
  password: await bcrypt.hash(String(plain), await bcrypt.genSalt(10)),
  passwordEnc: encrypt(String(plain))
});

// Admin-only view of a member: the normal serialisation plus the readable
// password. The document must have been loaded with +passwordEnc. `null` means
// the account predates stored passwords — the admin can set one from Edit.
const withPassword = (doc) => ({ ...doc.toJSON(), password: decrypt(doc.passwordEnc) });

// ---------------------------------------------------------------------------
// 1. REGISTER ASSOCIATE — admin only.
//
// The admin picks the sponsor the associate is being registered under and
// records what the sponsor paid; that raises the referral (and its invoice).
// The leg is optional: with one, the member is placed under the sponsor right
// away (spilling down that leg if needed); without one, they stay unplaced and
// the sponsor places them from their portal.
//
// The very first associate has no sponsor and becomes the tree root.
// ---------------------------------------------------------------------------
exports.registerAssociate = async (req, res, next) => {
  try {
    const { password, tier, sponsorId, position } = req.body;
    const details = pickAllowedFields(req.body, MEMBER_DETAIL_FIELDS);

    if (!details.email || !details.phone || !password) {
      return res.status(400).json({ success: false, message: 'Email, phone and password are required.' });
    }
    if (String(password).length < MIN_ADMIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
      });
    }
    if (!Object.values(TIERS).includes(tier)) {
      return res.status(400).json({
        success: false,
        message: `Tier is required and must be one of: ${Object.values(TIERS).join(', ')}.`
      });
    }
    if (position && ![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
      return res.status(400).json({ success: false, message: 'Leg must be either "Left" or "Right".' });
    }

    await assertUniqueContact(details);

    // Exactly one member may be the tree root. "Unplaced" and "root" both have
    // parentId null, so the distinction lives in treeStatus.
    const treeExists = await Associate.exists({
      role: ROLES.ASSOCIATE,
      treeStatus: { $ne: TREE_STATUSES.UNPLACED }
    });

    let sponsor = null;
    if (sponsorId) {
      sponsor = await Associate.findById(sponsorId).select('memberCode fullName role status treeStatus');
      if (!sponsor) {
        return res.status(404).json({ success: false, message: 'Sponsor not found.' });
      }
      if (sponsor.role !== ROLES.ASSOCIATE) {
        return res.status(400).json({ success: false, message: 'Only an associate can be the sponsor.' });
      }
      if (sponsor.status !== STATUSES.APPROVED) {
        return res.status(400).json({ success: false, message: `Cannot make a ${sponsor.status} account a sponsor.` });
      }
      // A sponsor outside the tree has nowhere to place anyone — the member
      // would be stuck unplaced for good.
      if (sponsor.treeStatus === TREE_STATUSES.UNPLACED) {
        return res.status(400).json({
          success: false,
          message: `${sponsor.memberCode} is not in the tree yet, so they cannot sponsor anyone.`
        });
      }
    } else if (treeExists) {
      return res.status(400).json({
        success: false,
        message: 'Choose the sponsor this associate is being registered under.'
      });
    }

    if (position && !sponsor) {
      return res.status(400).json({ success: false, message: 'A leg can only be chosen together with a sponsor.' });
    }

    // Validated before any code is minted, so a bad payment doesn't burn one.
    const payment = sponsor ? await parsePayment(req.body) : null;
    const placeNow = Boolean(sponsor && position);
    const { profileImage, documents } = collectUploads(req);

    // Minted outside the transaction so a retry reuses the same codes rather
    // than burning new ones on every attempt.
    const memberCode = await nextMemberCode();
    const referralNo = sponsor ? await nextReferralNo() : null;
    const invoiceNo = sponsor ? await nextInvoiceNo() : null;
    const credentials = await passwordFields(password);

    const { member, referral, parent } = await withTransaction(async (session) => {
      const created = await createAndPlace(
        {
          memberData: {
            ...details,
            ...credentials,
            memberCode,
            tier,
            // Placement is what approves a member, so someone placed right
            // away is live immediately; everyone else waits for placement.
            status: placeNow ? STATUSES.APPROVED : STATUSES.PENDING,
            treeStatus: sponsor ? TREE_STATUSES.UNPLACED : TREE_STATUSES.ROOT,
            sponsorId: sponsor ? sponsor._id : null,
            sponsorMemberCode: sponsor ? sponsor.memberCode : null,
            profileImage,
            documents
          },
          // Spillover starts at the sponsor, so the member always lands inside
          // the sponsor's own downline.
          requestedParentId: placeNow ? sponsor._id : null,
          position
        },
        session
      );

      if (!sponsor) return { member: created, referral: null, parent: null };

      await Associate.findByIdAndUpdate(sponsor._id, { $inc: { directCount: 1 } }, { session });

      const placedUnder = placeNow
        ? await Associate.findById(created.parentId).select('memberCode fullName').session(session)
        : null;

      const [raised] = await Referral.create(
        [
          {
            referralNo,
            invoiceNo,
            ...paymentFields(payment),
            tier,
            member: created._id,
            memberCode,
            memberName: created.fullName,
            issuedTo: sponsor._id,
            issuedToCode: sponsor.memberCode,
            issuedBy: req.user._id,
            ...(placeNow && {
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

      return { member: created, referral: raised, parent: placedUnder };
    });

    await record(req, {
      action: ACTIONS.MEMBER_REGISTERED,
      targetType: 'Associate',
      target: member._id,
      targetCode: member.memberCode,
      after: {
        tier,
        sponsor: sponsor ? sponsor.memberCode : null,
        treeStatus: member.treeStatus,
        placedUnder: parent ? parent.memberCode : null,
        position: member.position
      }
    });

    if (referral) {
      await record(req, {
        action: ACTIONS.REFERRAL_ISSUED,
        targetType: 'Referral',
        target: referral._id,
        targetCode: referral.referralNo,
        after: {
          invoiceNo: referral.invoiceNo,
          member: member.memberCode,
          sponsor: sponsor.memberCode,
          tier,
          amountPaid: payment.amountPaid,
          paymentMode: payment.paymentMode,
          paymentRef: payment.paymentRef,
          receivedOn: payment.receivedOn,
          receivedBy: payment.receiver ? payment.receiver.memberCode || payment.receiver.fullName : null,
          placedByAdmin: placeNow
        }
      });
    }

    let message = 'Associate registered as the tree root.';
    if (placeNow) {
      message = `Associate registered and placed under ${parent.memberCode} (${member.position} leg).`;
    } else if (sponsor) {
      message = `Associate registered under ${sponsor.memberCode}. They are not in the tree yet — ${sponsor.fullName} can place them from their portal.`;
    }

    return res.status(201).json({
      success: true,
      message,
      data: withPassword(member),
      referral: referral ? { _id: referral._id, referralNo: referral.referralNo, invoiceNo: referral.invoiceNo } : null
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 2. PENDING PLACEMENT — members registered under the caller, not yet placed.
// ---------------------------------------------------------------------------
exports.getPendingPlacement = async (req, res, next) => {
  try {
    const members = await Associate.find({
      role: ROLES.ASSOCIATE,
      sponsorId: req.user._id,
      treeStatus: TREE_STATUSES.UNPLACED
    })
      .select('memberCode fullName email phone tier status createdAt')
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: members.length,
      data: members.map((m) => ({
        _id: m._id,
        memberCode: m.memberCode,
        fullName: m.fullName,
        email: m.email,
        phone: m.phone,
        tier: m.tier,
        tierLabel: TIER_LABELS[m.tier] || null,
        status: m.status,
        joinedAt: m.createdAt
      }))
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 3. PLACEMENT PARENTS — who can the caller place a member under?
//
// Associates: themselves and their own downline, never anywhere else in the
// tree. Only nodes with at least one open leg are useful, so full nodes are
// left out, and each row says which legs are open.
// ---------------------------------------------------------------------------
exports.getPlacementParents = async (req, res, next) => {
  try {
    const isAdmin = req.user.role === ROLES.ADMIN;
    const q = String(req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit) || 15));

    const clauses = [
      { role: ROLES.ASSOCIATE },
      { treeStatus: { $ne: TREE_STATUSES.UNPLACED } },
      { $or: [{ leftChild: null }, { rightChild: null }] }
    ];
    if (!isAdmin) {
      clauses.push({ $or: [{ _id: req.user._id }, { ancestors: req.user._id }] });
    }
    if (q) {
      const rx = { $regex: escapeRegex(q), $options: 'i' };
      clauses.push({ $or: [{ memberCode: rx }, { fullName: rx }] });
    }

    const rows = await Associate.find({ $and: clauses })
      .select('memberCode fullName depth leftChild rightChild')
      .sort({ depth: 1, memberCode: 1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map((r) => ({
        _id: r._id,
        memberCode: r.memberCode,
        fullName: r.fullName,
        isSelf: String(r._id) === String(req.user._id),
        // 0 = the caller themselves, 1 = directly below them, …
        levelsBelow: isAdmin ? r.depth : r.depth - req.user.depth,
        leftOpen: !r.leftChild,
        rightOpen: !r.rightChild
      }))
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 4. PLACE A MEMBER — the sponsor puts someone they referred into their tree.
//
// The sponsor chooses the exact parent (themselves or anyone below them) and
// the leg. No spillover: they picked that spot, so a taken slot is an error
// rather than a silent move somewhere else.
// ---------------------------------------------------------------------------
exports.placeMember = async (req, res, next) => {
  try {
    const isAdmin = req.user.role === ROLES.ADMIN;
    const { parentId, position } = req.body;

    if (!parentId) {
      return res.status(400).json({ success: false, message: 'Choose the parent this member will sit under.' });
    }
    if (![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
      return res.status(400).json({ success: false, message: 'Choose the Left or Right leg.' });
    }

    const member = await Associate.findById(req.params.id).select('memberCode fullName role sponsorId treeStatus');

    // Same reply for "doesn't exist" and "not yours", so ids can't be probed.
    if (!member || member.role !== ROLES.ASSOCIATE || (!isAdmin && String(member.sponsorId) !== String(req.user._id))) {
      return res.status(404).json({ success: false, message: 'Member not found among the associates you referred.' });
    }
    if (member.treeStatus !== TREE_STATUSES.UNPLACED) {
      return res.status(409).json({ success: false, message: `${member.memberCode} is already in the tree.` });
    }

    const parent = await Associate.findById(parentId).select('memberCode fullName role treeStatus ancestors leftChild rightChild');
    const inScope =
      parent &&
      parent.role === ROLES.ASSOCIATE &&
      parent.treeStatus !== TREE_STATUSES.UNPLACED &&
      (isAdmin ||
        String(parent._id) === String(req.user._id) ||
        parent.ancestors.some((a) => String(a) === String(req.user._id)));

    if (!inScope) {
      return res.status(400).json({ success: false, message: 'The parent must be you or someone in your own tree.' });
    }
    // Checked up front for a clear message; placeExisting re-checks atomically.
    if (parent[childField(position)]) {
      return res.status(409).json({
        success: false,
        message: `${parent.memberCode}'s ${position} leg is already taken. Choose another leg or parent.`
      });
    }

    const placedBy = isAdmin ? 'admin' : 'sponsor';

    const placed = await withTransaction(async (session) => {
      const result = await placeExisting(
        {
          memberId: member._id,
          requestedParentId: parent._id,
          position,
          exact: true,
          // Placement is the approval: the admin vetted and registered them.
          extra: { status: STATUSES.APPROVED }
        },
        session
      );
      await markReferralPlaced(member._id, { by: placedBy, position, parentCode: parent.memberCode }, session);
      return result;
    });

    await record(req, {
      action: ACTIONS.MEMBER_PLACED,
      targetType: 'Associate',
      target: member._id,
      targetCode: member.memberCode,
      after: { placedBy, placedUnder: parent.memberCode, position, depth: placed.member.depth }
    });

    return res.status(200).json({
      success: true,
      message: `${member.memberCode} placed under ${parent.memberCode} (${position} leg).`,
      data: {
        _id: placed.member._id,
        memberCode: placed.member.memberCode,
        fullName: placed.member.fullName,
        position,
        depth: placed.member.depth,
        placedUnder: { memberCode: parent.memberCode, fullName: parent.fullName }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 5. PLACEMENT PREVIEW — "Will be placed under TGE0098 (3 levels below)".
// ---------------------------------------------------------------------------
exports.getPlacementPreview = async (req, res, next) => {
  try {
    const { position } = req.query;

    // Associates always preview from themselves; admins may preview from any
    // node, e.g. the sponsor chosen on the registration form.
    let rootId = req.user._id;
    if (req.user.role === ROLES.ADMIN && (req.query.sponsorId || req.query.parentId)) {
      rootId = req.query.sponsorId || req.query.parentId;
    }

    const preview = await previewPlacement(rootId, position);
    return res.status(200).json({ success: true, data: preview });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 6. LOOKUP BY MEMBER CODE
// ---------------------------------------------------------------------------
exports.lookupByCode = async (req, res, next) => {
  try {
    const associate = await Associate.findOne({
      memberCode: String(req.params.memberCode).toUpperCase().trim(),
      role: ROLES.ASSOCIATE
    }).select('memberCode fullName status tier');

    if (!associate) {
      return res.status(404).json({ success: false, message: 'No associate found with that code.' });
    }

    return res.status(200).json({
      success: true,
      data: {
        _id: associate._id,
        memberCode: associate.memberCode,
        fullName: associate.fullName,
        status: associate.status,
        tier: associate.tier
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 7. SEARCH — powers the admin's searchable selects (sponsor, receivedBy,
// parent). Admin-only, because it can enumerate the membership.
// ---------------------------------------------------------------------------
exports.searchAssociates = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit) || 10));

    const filter = {};

    if (req.query.role && Object.values(ROLES).includes(req.query.role)) {
      filter.role = req.query.role;
    }
    if (req.query.status && Object.values(STATUSES).includes(req.query.status)) {
      filter.status = req.query.status;
    }
    // Keeps an associate out of their own sponsor/parent list.
    if (req.query.exclude) {
      filter._id = { $ne: req.query.exclude };
    }
    // The Generate Referral member picker only wants people who can still be
    // given a sponsor: not in the tree and not sponsored.
    if (req.query.referable === 'true') {
      filter.treeStatus = TREE_STATUSES.UNPLACED;
      filter.sponsorId = null;
    } else if (req.query.inTree === 'true') {
      // Sponsor and parent pickers only want people who are actually in the tree.
      filter.treeStatus = { $ne: TREE_STATUSES.UNPLACED };
    } else if (req.query.treeStatus && Object.values(TREE_STATUSES).includes(req.query.treeStatus)) {
      filter.treeStatus = req.query.treeStatus;
    }

    if (q) {
      // Escaped — raw user input in a $regex would let "(((" throw, or a
      // pathological pattern burn CPU.
      const rx = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ memberCode: rx }, { fullName: rx }, { email: rx }, { phone: rx }];
    }

    const results = await Associate.find(filter)
      .select('memberCode fullName email role status tier treeStatus')
      .sort({ memberCode: 1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      count: results.length,
      data: results.map((a) => ({
        _id: a._id,
        memberCode: a.memberCode || null,
        fullName: a.fullName,
        email: a.email,
        role: a.role,
        status: a.status,
        tier: a.tier || null,
        treeStatus: a.treeStatus || null,
        // Ready-made dropdown label: "TGE0042 — Rakesh" / "Admin — System Administrator"
        label: `${a.memberCode || (a.role === ROLES.ADMIN ? 'Admin' : '—')} — ${a.fullName}`
      }))
    });
  } catch (error) {
    next(error);
  }
};

// Binary tree lives in treeController. GET /api/associates/tree/:id is kept as
// an alias for the existing frontend.

// 8. VIEW ALL ASSOCIATES (admin) — includes each member's password.
exports.getAllAssociates = async (req, res, next) => {
  try {
    const { status, tier, search, treeStatus } = req.query;

    // Admin accounts share this collection but sit outside the tree — they are
    // never part of a member listing.
    const filter = { role: ROLES.ASSOCIATE };

    if (status) filter.status = status;
    if (tier) filter.tier = tier;
    if (treeStatus && Object.values(TREE_STATUSES).includes(treeStatus)) {
      filter.treeStatus = treeStatus;
    }
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }, { memberCode: rx }];
    }

    const associates = await Associate.find(filter)
      .select('+passwordEnc')
      .populate('sponsorId', 'memberCode fullName email phone')
      .populate('parentId', 'memberCode fullName email phone')
      .populate('leftChild', 'memberCode fullName email phone')
      .populate('rightChild', 'memberCode fullName email phone');

    res.status(200).json({ success: true, count: associates.length, data: associates.map(withPassword) });
  } catch (error) {
    next(error);
  }
};

// 9. VIEW ASSOCIATE BY ID — associates may read their downline, but only an
// admin ever receives the password.
exports.getAssociateById = async (req, res, next) => {
  try {
    const isAdmin = req.user.role === ROLES.ADMIN;

    const query = Associate.findById(req.params.id)
      .populate('sponsorId', 'memberCode fullName email phone')
      .populate('parentId', 'memberCode fullName email phone')
      .populate('leftChild', 'memberCode fullName email phone')
      .populate('rightChild', 'memberCode fullName email phone');
    if (isAdmin) query.select('+passwordEnc');

    const associate = await query;
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    if (!isAdmin) return res.status(200).json({ success: true, data: associate });

    // The edit form pre-fills the payment from the member's live referral.
    const referral = await Referral.findOne({
      member: associate._id,
      status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] }
    })
      .populate('receivedBy', 'memberCode fullName email phone')
      .lean();

    res.status(200).json({
      success: true,
      data: {
        ...withPassword(associate),
        referral: referral
          ? {
              _id: referral._id,
              referralNo: referral.referralNo,
              invoiceNo: referral.invoiceNo,
              status: referral.status,
              amountPaid: referral.amountPaid,
              paymentMode: referral.paymentMode || null,
              paymentRef: referral.paymentRef || '',
              receivedOn: referral.receivedOn || null,
              receivedBy: referral.receivedBy || null,
              notes: referral.notes || ''
            }
          : null
      }
    });
  } catch (error) {
    next(error);
  }
};

// 10. EDIT ASSOCIATE
exports.updateAssociate = async (req, res, next) => {
  try {
    const isAdmin = req.user.role === ROLES.ADMIN;

    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    // Whitelist, never spread. Without this an authenticated associate could
    // PATCH themselves with { role: 'admin' } or { tier: 'Tier II' }.
    const updateFields = pickAllowedFields(
      req.body,
      isAdmin ? ADMIN_UPDATABLE_FIELDS : SELF_UPDATABLE_FIELDS
    );

    // The admin manages passwords directly. Associates change their own through
    // /auth/change-password, which checks the current one first.
    let passwordSet = false;
    if (isAdmin && req.body.password) {
      if (String(req.body.password).length < MIN_ADMIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          success: false,
          message: `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`
        });
      }
      Object.assign(updateFields, await passwordFields(req.body.password));
      passwordSet = true;
    }

    // Sponsor change — admin only, and only when a DIFFERENT sponsor is sent.
    // Everything is validated here, before any write below.
    let newSponsor = null;
    const requestedSponsorId = isAdmin ? (req.body.sponsorId || null) : null;
    if (requestedSponsorId && String(requestedSponsorId) !== String(associate.sponsorId || '')) {
      if (associate.treeStatus === TREE_STATUSES.ROOT) {
        return res.status(400).json({ success: false, message: 'The tree root cannot have a sponsor.' });
      }
      if (String(requestedSponsorId) === String(associate._id)) {
        return res.status(400).json({ success: false, message: 'An associate cannot sponsor themselves.' });
      }
      newSponsor = await Associate.findById(requestedSponsorId).select('memberCode fullName role status treeStatus');
      if (!newSponsor) {
        return res.status(404).json({ success: false, message: 'Sponsor not found.' });
      }
      if (newSponsor.role !== ROLES.ASSOCIATE) {
        return res.status(400).json({ success: false, message: 'Only an associate can be the sponsor.' });
      }
      if (newSponsor.status !== STATUSES.APPROVED) {
        return res.status(400).json({ success: false, message: `Cannot make a ${newSponsor.status} account a sponsor.` });
      }
      if (newSponsor.treeStatus === TREE_STATUSES.UNPLACED) {
        return res.status(400).json({
          success: false,
          message: `${newSponsor.memberCode} is not in the tree yet, so they cannot sponsor anyone.`
        });
      }
      if (await isInSponsorChain(newSponsor._id, associate._id)) {
        return res.status(400).json({
          success: false,
          message: `${newSponsor.memberCode} was referred through ${associate.memberCode}, so they can't become their sponsor — that would create a loop.`
        });
      }
    }

    // Payment on the member's referral — admin only. The edit form sends it
    // (flagged) whenever the member has a sponsor; blanks clear a field and an
    // empty amount is recorded as 0.
    const effectiveSponsorId = newSponsor ? newSponsor._id : associate.sponsorId;
    const payment =
      isAdmin && effectiveSponsorId && String(req.body.paymentSubmitted) === 'true'
        ? await parsePayment(req.body)
        : null;
    // Only real input raises a brand-new invoice — the pre-filled date alone doesn't.
    const paymentHasInput = ['amountPaid', 'paymentMode', 'paymentRef', 'receivedBy', 'notes'].some((key) => req.body[key]);

    // Binary tree (re-)placement — admin only, and only when the client
    // explicitly supplies a parent AND a position together. Editing unrelated
    // fields must never move an associate around the tree.
    const requestedParentId = isAdmin ? (req.body.parentId || null) : null;
    const requestedPosition = isAdmin ? (req.body.position || null) : null;

    if (requestedParentId && requestedPosition) {
      if (String(requestedParentId) === String(associate._id)) {
        return res.status(400).json({ success: false, message: 'An associate cannot be placed under themselves.' });
      }

      // Loop guard. Moving a node under its own descendant closes a cycle,
      // after which every ancestor walk, tree render and report would spin
      // forever. The materialised path makes this an O(1) membership test.
      const proposedParent = await Associate.findById(requestedParentId).select('ancestors depth treeStatus');
      if (!proposedParent) {
        return res.status(404).json({ success: false, message: 'Specified Parent node not found.' });
      }
      if (proposedParent.treeStatus === TREE_STATUSES.UNPLACED) {
        return res.status(400).json({ success: false, message: 'The chosen parent is not in the tree yet.' });
      }
      if (proposedParent.ancestors.some((a) => String(a) === String(associate._id))) {
        return res.status(400).json({
          success: false,
          message: 'Cannot place an associate under their own downline — this would create a loop.'
        });
      }

      let targetParentId;
      try {
        targetParentId = await resolveTreeTarget(requestedParentId, requestedPosition, associate._id);
      } catch (err) {
        return res.status(err.status || 500).json({ success: false, message: err.message });
      }

      // Spillover can land on a different node than the one just checked, so
      // re-verify the loop guard against the resolved target.
      const resolvedParent = await Associate.findById(targetParentId).select('memberCode ancestors depth');
      if (!resolvedParent) {
        return res.status(404).json({ success: false, message: 'Resolved parent node not found.' });
      }
      if (
        String(resolvedParent._id) === String(associate._id) ||
        resolvedParent.ancestors.some((a) => String(a) === String(associate._id))
      ) {
        return res.status(400).json({
          success: false,
          message: 'Spillover resolved inside this associate\'s own downline — move rejected.'
        });
      }

      const unchanged =
        associate.parentId &&
        String(associate.parentId) === String(targetParentId) &&
        associate.position === requestedPosition;

      if (!unchanged) {
        const wasUnplaced = associate.treeStatus === TREE_STATUSES.UNPLACED;

        await detachFromParent(associate.parentId, associate.position, associate._id);
        const claimed = await claimSlot(targetParentId, requestedPosition, associate._id);
        if (!claimed) {
          return res.status(409).json({
            success: false,
            message: 'That placement slot was taken concurrently. Please retry.'
          });
        }

        // Re-path this node and its entire subtree.
        const { ancestors, depth } = await repathSubtree(associate, resolvedParent);
        updateFields.ancestors = ancestors;
        updateFields.depth = depth;

        if (wasUnplaced) {
          // First time in the tree: close the referral the sponsor would
          // otherwise still see as waiting.
          await markReferralPlaced(associate._id, {
            by: 'admin',
            position: requestedPosition,
            parentCode: resolvedParent.memberCode
          });
        }

        // A move changes whose downline this member counts toward, so it is
        // the single most dispute-prone action in the system.
        await record(req, {
          action: wasUnplaced ? ACTIONS.MEMBER_PLACED : ACTIONS.MEMBER_MOVED,
          targetType: 'Associate',
          target: associate._id,
          targetCode: associate.memberCode,
          before: { parentId: associate.parentId, position: associate.position, depth: associate.depth },
          after: { parentId: targetParentId, position: requestedPosition, depth }
        });
      }

      updateFields.parentId = targetParentId;
      updateFields.position = requestedPosition;
      updateFields.treeStatus = TREE_STATUSES.PLACED;
    }

    // --- Sponsor + referral writes (admin) -----------------------------------
    // After placement, so a referral just closed by a placement above is read
    // as it now is.
    if (isAdmin && (newSponsor || payment)) {
      const referral = await Referral.findOne({
        member: associate._id,
        status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] }
      });

      if (newSponsor) {
        updateFields.sponsorId = newSponsor._id;
        updateFields.sponsorMemberCode = newSponsor.memberCode;
        if (associate.sponsorId) {
          await Associate.findByIdAndUpdate(associate.sponsorId, { $inc: { directCount: -1 } });
        }
        await Associate.findByIdAndUpdate(newSponsor._id, { $inc: { directCount: 1 } });

        // Moves referral credit, so it is as dispute-prone as a tree move.
        await record(req, {
          action: ACTIONS.MEMBER_SPONSOR_CHANGED,
          targetType: 'Associate',
          target: associate._id,
          targetCode: associate.memberCode,
          before: { sponsor: associate.sponsorMemberCode || null },
          after: { sponsor: newSponsor.memberCode }
        });
      }

      if (referral) {
        const before = {
          issuedToCode: referral.issuedToCode,
          amountPaid: referral.amountPaid,
          paymentMode: referral.paymentMode,
          paymentRef: referral.paymentRef
        };
        if (newSponsor) {
          referral.issuedTo = newSponsor._id;
          referral.issuedToCode = newSponsor.memberCode;
          referral.readAt = null; // the new sponsor gets the "new referral" badge
        }
        if (payment) Object.assign(referral, paymentFields(payment));

        if (referral.isModified()) {
          await referral.save();
          await record(req, {
            action: ACTIONS.REFERRAL_UPDATED,
            targetType: 'Referral',
            target: referral._id,
            targetCode: referral.referralNo,
            before,
            after: {
              issuedToCode: referral.issuedToCode,
              amountPaid: referral.amountPaid,
              paymentMode: referral.paymentMode,
              paymentRef: referral.paymentRef
            }
          });
        }
      } else if (newSponsor || (payment && paymentHasInput)) {
        // No live referral yet — e.g. a member who was registered before
        // sponsors were set at registration. Raise one so both sides get the
        // invoice.
        const finalTreeStatus = updateFields.treeStatus || associate.treeStatus;
        const finalParentId = updateFields.parentId || associate.parentId;
        const inTree = finalTreeStatus !== TREE_STATUSES.UNPLACED;
        const placedUnder = inTree && finalParentId
          ? await Associate.findById(finalParentId).select('memberCode')
          : null;

        const raised = await Referral.create({
          referralNo: await nextReferralNo(),
          invoiceNo: await nextInvoiceNo(),
          ...paymentFields(payment || (await parsePayment({}))),
          tier: associate.tier,
          member: associate._id,
          memberCode: associate.memberCode,
          memberName: updateFields.fullName || associate.fullName,
          issuedTo: effectiveSponsorId,
          issuedToCode: newSponsor ? newSponsor.memberCode : associate.sponsorMemberCode,
          issuedBy: req.user._id,
          ...(inTree && {
            status: REFERRAL_STATUSES.USED,
            usedAt: new Date(),
            placedPosition: updateFields.position || associate.position,
            placedUnderCode: placedUnder ? placedUnder.memberCode : null
          })
        });

        await record(req, {
          action: ACTIONS.REFERRAL_ISSUED,
          targetType: 'Referral',
          target: raised._id,
          targetCode: raised.referralNo,
          after: {
            invoiceNo: raised.invoiceNo,
            member: associate.memberCode,
            sponsor: raised.issuedToCode,
            amountPaid: raised.amountPaid,
            raisedFromEdit: true
          }
        });
      }
    }

    const { profileImage, documents } = collectUploads(req);

    if (profileImage.url) {
      if (associate.profileImage && associate.profileImage.public_id) {
        await cloudinary.uploader.destroy(associate.profileImage.public_id);
      }
      updateFields.profileImage = profileImage;
    }

    if (documents.length) {
      updateFields.documents = [...(associate.documents || []), ...documents];
    }

    const updateQuery = Associate.findByIdAndUpdate(req.params.id, updateFields, { new: true, runValidators: true });
    if (isAdmin) updateQuery.select('+passwordEnc');
    const updatedAssociate = await updateQuery;

    if (passwordSet) {
      await record(req, {
        action: ACTIONS.PASSWORD_SET_BY_ADMIN,
        targetType: 'Associate',
        target: associate._id,
        targetCode: associate.memberCode
      });
    }

    res.status(200).json({
      success: true,
      message: 'Associate updated successfully',
      data: isAdmin ? withPassword(updatedAssociate) : updatedAssociate
    });
  } catch (error) {
    next(error);
  }
};

// 11. APPROVE / REJECT REGISTRATION
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!Object.values(STATUSES).includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    const associate = await Associate.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    await record(req, {
      action: ACTIONS.MEMBER_STATUS_CHANGED,
      targetType: 'Associate',
      target: associate._id,
      targetCode: associate.memberCode,
      after: { status }
    });

    res.status(200).json({ success: true, message: `Associate registration status updated to ${status}`, data: associate });
  } catch (error) {
    next(error);
  }
};

// 12. DELETE ASSOCIATE
exports.deleteAssociate = async (req, res, next) => {
  try {
    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    // Deleting a node that still has children would strand its whole subtree:
    // the descendants keep an ancestors path through a member that no longer
    // exists, and every downline report below that point breaks.
    if (associate.leftChild || associate.rightChild) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete an associate who still has downline members. Re-place them first.'
      });
    }

    if (associate.profileImage && associate.profileImage.public_id) {
      await cloudinary.uploader.destroy(associate.profileImage.public_id);
    }

    if (associate.documents && associate.documents.length > 0) {
      for (const doc of associate.documents) {
        if (doc.public_id) await cloudinary.uploader.destroy(doc.public_id);
      }
    }

    await detachFromParent(associate.parentId, associate.position, associate._id);

    if (associate.sponsorId) {
      await Associate.findByIdAndUpdate(associate.sponsorId, { $inc: { directCount: -1 } });
    }

    await record(req, {
      action: ACTIONS.MEMBER_DELETED,
      targetType: 'Associate',
      target: associate._id,
      targetCode: associate.memberCode,
      before: {
        fullName: associate.fullName,
        email: associate.email,
        tier: associate.tier,
        sponsorMemberCode: associate.sponsorMemberCode,
        parentId: associate.parentId,
        position: associate.position
      }
    });

    await Associate.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Associate deleted successfully' });
  } catch (error) {
    next(error);
  }
};
