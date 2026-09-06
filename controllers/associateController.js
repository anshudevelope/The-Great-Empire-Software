const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const bcrypt = require('bcryptjs');
const { cloudinary } = require('../config/cloudinary');
const { nextMemberCode } = require('../utils/codes');
const { generateTempPassword } = require('../utils/password');
const { withTransaction } = require('../utils/transaction');
const { assertRedeemable } = require('../services/referralService');
const { record, ACTIONS } = require('../services/auditService');
const {
  resolveTreeTarget,
  detachFromParent,
  repathSubtree,
  createAndPlace,
  previewPlacement,
  claimSlot
} = require('../services/placementService');
const {
  ROLES,
  STATUSES,
  TIERS,
  TIER_LABELS,
  POSITIONS,
  REFERRAL_STATUSES,
  ADMIN_UPDATABLE_FIELDS,
  SELF_UPDATABLE_FIELDS,
  pickAllowedFields
} = require('../config/constants');

// Personal fields accepted for a new member. Structural fields (tier, sponsor,
// placement) are never read from the form on the redeem path — they come from
// the voucher.
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
  if (existing) {
    const err = new Error('Email or Phone already registered.');
    err.status = 400;
    throw err;
  }
};

// ---------------------------------------------------------------------------
// 1. REGISTER ASSOCIATE — Path A: admin creates directly, no voucher.
//    Used for the root (TRG0001), corrections and offline onboarding.
// ---------------------------------------------------------------------------
exports.registerAssociate = async (req, res, next) => {
  try {
    const { password, sponsorId, parentId, position, tier } = req.body;

    const details = pickAllowedFields(req.body, MEMBER_DETAIL_FIELDS);

    if (!details.email || !details.phone || !password) {
      return res.status(400).json({ success: false, message: 'Email, phone and password are required.' });
    }
    if (!Object.values(TIERS).includes(tier)) {
      return res.status(400).json({
        success: false,
        message: `Tier is required and must be one of: ${Object.values(TIERS).join(', ')}.`
      });
    }

    await assertUniqueContact(details);

    const requestedParentId = parentId || sponsorId || null;

    // The root (TRG0001) is the ONLY member allowed to have no parent. Without
    // this guard a second parentless registration silently starts a detached
    // second tree, and every downline report under-counts from then on.
    if (!requestedParentId) {
      const rootExists = await Associate.exists({ role: ROLES.ASSOCIATE, parentId: null });
      if (rootExists) {
        return res.status(400).json({
          success: false,
          message: 'A root associate already exists. A parent or sponsor is required.'
        });
      }
    } else if (!position) {
      return res.status(400).json({
        success: false,
        message: 'Position (Left or Right) is required when a parent or sponsor is given.'
      });
    }

    let sponsorCode = null;
    if (sponsorId) {
      const sponsorDoc = await Associate.findById(sponsorId).select('memberCode');
      if (!sponsorDoc) return res.status(404).json({ success: false, message: 'Sponsor not found.' });
      sponsorCode = sponsorDoc.memberCode || null;
    }

    const { profileImage, documents } = collectUploads(req);

    // Minted outside the transaction so a retry reuses the same code rather
    // than burning a new one on every attempt.
    const memberCode = await nextMemberCode();

    const member = await withTransaction(async (session) => {
      const created = await createAndPlace(
        {
          memberData: {
            ...details,
            memberCode,
            password: await bcrypt.hash(password, await bcrypt.genSalt(10)),
            sponsorId: sponsorId || null,
            sponsorCode,
            tier,
            status: STATUSES.PENDING,
            // Whoever creates the account knows the password they typed, so
            // the member must replace it before they can do anything.
            mustChangePassword: true,
            profileImage,
            documents
          },
          requestedParentId,
          position
        },
        session
      );

      if (sponsorId) {
        await Associate.findByIdAndUpdate(sponsorId, { $inc: { directCount: 1 } }, { session });
      }

      return created;
    });

    await record(req, {
      action: ACTIONS.MEMBER_REGISTERED,
      targetType: 'Associate',
      target: member._id,
      targetCode: member.memberCode,
      after: { tier, sponsorCode, parentId: member.parentId, position: member.position }
    });

    return res.status(201).json({
      success: true,
      message: 'Registration successful! Account pending admin approval.',
      data: member // toJSON transform drops the password hash
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 2. REDEEM A REFERRAL — Path B: an associate adds a member using a voucher.
//
// The voucher supplies the sponsor and the tier, so the form only asks for the
// new member's details and ONE tree input: which leg.
// ---------------------------------------------------------------------------
exports.redeemReferral = async (req, res, next) => {
  try {
    const { referralNo, pin, position } = req.body;

    if (![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
      return res.status(400).json({ success: false, message: 'Position must be either "Left" or "Right".' });
    }

    const details = pickAllowedFields(req.body, MEMBER_DETAIL_FIELDS);
    if (!details.email || !details.phone || !details.fullName) {
      return res.status(400).json({ success: false, message: 'Full name, email and phone are required.' });
    }

    // Re-run the full voucher check here rather than trusting that /verify was
    // called first — nothing stops a client from calling redeem directly.
    // This also enforces that the voucher was issued to THIS caller.
    const referral = await assertRedeemable(referralNo, pin, req.user._id);

    await assertUniqueContact(details);

    const { profileImage, documents } = collectUploads(req);

    // Shown to the sponsor exactly once. The member is flagged
    // mustChangePassword, so the sponsor never learns the permanent one.
    const tempPassword = generateTempPassword();
    const memberCode = await nextMemberCode();

    const member = await withTransaction(async (session) => {
      // Claim the voucher FIRST, conditionally. Without this a double-submit
      // creates two members from one paid voucher. If the placement below
      // fails, the transaction rolls this back to 'unused'.
      const claimed = await Referral.findOneAndUpdate(
        { _id: referral._id, status: REFERRAL_STATUSES.UNUSED },
        { status: REFERRAL_STATUSES.USED, usedAt: new Date() },
        { new: true, session }
      );
      if (!claimed) {
        const err = new Error('This referral has already been used.');
        err.status = 409;
        throw err;
      }

      const created = await createAndPlace(
        {
          memberData: {
            ...details,
            memberCode,
            password: await bcrypt.hash(tempPassword, await bcrypt.genSalt(10)),
            // Sponsor and tier come from the voucher, never from the form.
            sponsorId: referral.issuedTo,
            sponsorCode: referral.issuedToCode,
            tier: referral.tier,
            // A valid PIN IS the approval — admin already vetted the person and
            // collected payment when issuing the voucher.
            status: STATUSES.APPROVED,
            mustChangePassword: true,
            profileImage,
            documents
          },
          // Spillover starts at the sponsor, so the new member always lands
          // inside the sponsor's own downline.
          requestedParentId: referral.issuedTo,
          position
        },
        session
      );

      await Referral.findByIdAndUpdate(
        referral._id,
        { usedBy: created._id, usedByCode: created.memberCode },
        { session }
      );

      await Associate.findByIdAndUpdate(referral.issuedTo, { $inc: { directCount: 1 } }, { session });

      return created;
    });

    const parent = member.parentId
      ? await Associate.findById(member.parentId).select('memberCode fullName')
      : null;

    await record(req, {
      action: ACTIONS.MEMBER_REDEEMED,
      targetType: 'Associate',
      target: member._id,
      targetCode: member.memberCode,
      after: {
        referralNo: referral.referralNo,
        invoiceNo: referral.invoiceNo,
        sponsor: referral.issuedToCode,
        placedUnder: parent?.memberCode ?? null,
        position: member.position,
        tier: member.tier,
        spilledOver: parent ? String(member.parentId) !== String(referral.issuedTo) : false
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Member registered successfully.',
      // Displayed once, then never retrievable — hand it to the new member.
      tempPassword,
      data: {
        _id: member._id,
        memberCode: member.memberCode,
        fullName: member.fullName,
        email: member.email,
        tier: member.tier,
        tierLabel: TIER_LABELS[member.tier],
        status: member.status,
        position: member.position,
        depth: member.depth,
        sponsor: { memberCode: referral.issuedToCode },
        placedUnder: parent ? { memberCode: parent.memberCode, fullName: parent.fullName } : null,
        spilledOver: parent ? String(member.parentId) !== String(referral.issuedTo) : false
      }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 3. PLACEMENT PREVIEW — "Will be placed under TRG0098 (3 levels below you)".
// ---------------------------------------------------------------------------
exports.getPlacementPreview = async (req, res, next) => {
  try {
    const { position } = req.query;

    // Associates always preview from themselves; admins may preview from any
    // node for the direct-create path.
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
// 4. LOOKUP BY MEMBER CODE — validates a sponsor code on the admin form.
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
// 4b. SEARCH — powers the searchable selects (issuedTo, receivedBy, sponsor).
//
// Returns a deliberately thin projection: enough to identify a person in a
// dropdown, nothing more. Admin-only, because it can enumerate the membership.
// ---------------------------------------------------------------------------
exports.searchAssociates = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit) || 10));

    const filter = {};

    // Optional role filter: associates for `issuedTo`, admins (or both) for
    // `receivedBy`, since money is usually taken by an office account.
    if (req.query.role && Object.values(ROLES).includes(req.query.role)) {
      filter.role = req.query.role;
    }

    if (q) {
      // Escape regex metacharacters — raw user input in a $regex would
      // otherwise let a query like "(((" throw, or a pathological pattern
      // burn CPU.
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: 'i' };
      filter.$or = [{ memberCode: rx }, { fullName: rx }, { email: rx }, { phone: rx }];
    }

    const results = await Associate.find(filter)
      .select('memberCode fullName email role status tier')
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
        // Ready-made dropdown label: "TRG0042 — Rakesh" / "Admin — System Administrator"
        label: `${a.memberCode || (a.role === ROLES.ADMIN ? 'Admin' : '—')} — ${a.fullName}`
      }))
    });
  } catch (error) {
    next(error);
  }
};

// Binary tree now lives in treeController (single-query implementation).
// GET /api/associates/tree/:id is kept as an alias for the existing frontend.

// 6. VIEW ALL ASSOCIATES
exports.getAllAssociates = async (req, res, next) => {
  try {
    const { status, tier, search } = req.query;

    // Admin accounts share this collection but sit outside the tree — they are
    // never part of a member listing.
    let filter = { role: ROLES.ASSOCIATE };

    if (status) filter.status = status;
    if (tier) filter.tier = tier;
    if (search) {
      filter.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { memberCode: { $regex: search, $options: 'i' } }
      ];
    }

    const associates = await Associate.find(filter)
      .populate('sponsorId', 'memberCode fullName email phone')
      .populate('parentId', 'memberCode fullName email phone')
      .populate('leftChild', 'memberCode fullName email phone')
      .populate('rightChild', 'memberCode fullName email phone');

    res.status(200).json({ success: true, count: associates.length, data: associates });
  } catch (error) {
    next(error);
  }
};

// 7. VIEW ASSOCIATE BY ID
exports.getAssociateById = async (req, res, next) => {
  try {
    const associate = await Associate.findById(req.params.id)
      .populate('sponsorId', 'memberCode fullName email phone')
      .populate('parentId', 'memberCode fullName email phone')
      .populate('leftChild', 'memberCode fullName email phone')
      .populate('rightChild', 'memberCode fullName email phone');

    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    res.status(200).json({ success: true, data: associate });
  } catch (error) {
    next(error);
  }
};

// 8. EDIT ASSOCIATE
exports.updateAssociate = async (req, res, next) => {
  try {
    const isAdmin = req.user.role === ROLES.ADMIN;

    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    // Whitelist, never spread. Without this an authenticated associate could
    // PATCH themselves with { role: 'admin' } or { tier: 'Tier II' }.
    // Anything not on the list is silently dropped.
    const updateFields = pickAllowedFields(
      req.body,
      isAdmin ? ADMIN_UPDATABLE_FIELDS : SELF_UPDATABLE_FIELDS
    );

    // Binary tree (re-)placement — admin only, and only when the client
    // explicitly supplies a parent/sponsor AND a position together. Editing
    // unrelated fields must never move an associate around the tree.
    const requestedParentId = isAdmin ? (req.body.parentId || req.body.sponsorId || null) : null;
    const requestedPosition = isAdmin ? (req.body.position || null) : null;

    if (requestedParentId && requestedPosition) {
      if (String(requestedParentId) === String(associate._id)) {
        return res.status(400).json({ success: false, message: 'An associate cannot be placed under themselves.' });
      }

      // Loop guard. Moving a node under its own descendant closes a cycle,
      // after which every ancestor walk, tree render and report would spin
      // forever. The materialised path makes this an O(1) membership test.
      const proposedParent = await Associate.findById(requestedParentId).select('ancestors depth');
      if (!proposedParent) {
        return res.status(404).json({ success: false, message: 'Specified Parent node not found.' });
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
      const resolvedParent = await Associate.findById(targetParentId).select('ancestors depth');
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

        // A move changes whose downline this member counts toward, so it is
        // the single most dispute-prone action in the system.
        await record(req, {
          action: ACTIONS.MEMBER_MOVED,
          targetType: 'Associate',
          target: associate._id,
          targetCode: associate.memberCode,
          before: { parentId: associate.parentId, position: associate.position, depth: associate.depth },
          after: { parentId: targetParentId, position: requestedPosition, depth }
        });
      }

      updateFields.parentId = targetParentId;
      updateFields.position = requestedPosition;
    }

    // Passwords are changed only through POST /api/auth/change-password, which
    // verifies the current password first.
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

    const updatedAssociate = await Associate.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    );

    res.status(200).json({ success: true, message: 'Associate updated successfully', data: updatedAssociate });
  } catch (error) {
    next(error);
  }
};

// 9. APPROVE / REJECT REGISTRATION
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

// 10. DELETE ASSOCIATE
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

    // Clean up tree parent references
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
        sponsorCode: associate.sponsorCode,
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
