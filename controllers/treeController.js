const Associate = require('../models/Associate');
const { ROLES, TREE_STATUSES } = require('../config/constants');

// Everything a tree node or list row needs to render, and nothing more.
const NODE_FIELDS =
  'memberCode fullName email phone status tier position profileImage ' +
  'leftChild rightChild parentId sponsorId sponsorMemberCode treeStatus ancestors depth directCount createdAt';

const toNode = (a, parentCode = null) => ({
  _id: a._id,
  memberCode: a.memberCode,
  // Shown beside Sponsor in the node tooltip: the two differ whenever
  // spillover moved this member down a leg, which is the whole point.
  parentCode,
  fullName: a.fullName,
  email: a.email,
  phone: a.phone,
  status: a.status,
  tier: a.tier,
  position: a.position,
  profileImage: a.profileImage,
  // The member code of whoever sponsored them — the tooltip's "Sponsor PID".
  sponsorMemberCode: a.sponsorMemberCode,
  treeStatus: a.treeStatus,
  depth: a.depth,
  directCount: a.directCount,
  joinedAt: a.createdAt,
  // Raw child pointers are part of the contract: the UI uses them to tell an
  // empty slot apart from a child that exists but wasn't fetched at this depth.
  leftChild: a.leftChild || null,
  rightChild: a.rightChild || null,
  // Makes the sponsor≠parent split visible in the UI without another lookup.
  isSpillover: Boolean(a.sponsorId && a.parentId && String(a.sponsorId) !== String(a.parentId))
});

const parseDepth = (raw, fallback = 3) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, n)); // hard ceiling: an unbounded depth is a DoS
};

// ---------------------------------------------------------------------------
// GET /api/tree/binary/:id?depth=3   — the PLACEMENT tree
//
// Fetches the whole subtree in ONE indexed query on `ancestors`, then assembles
// it in memory. The previous per-node recursion issued up to 2^depth round
// trips (63 queries at depth 5) to render a single tree.
// ---------------------------------------------------------------------------
exports.getBinaryTree = async (req, res, next) => {
  try {
    const rootId = req.params.id;
    const depth = parseDepth(req.query.depth);

    const root = await Associate.findById(rootId).select(NODE_FIELDS).lean();
    if (!root) return res.status(404).json({ success: false, message: 'Associate not found' });

    const nodes = await Associate.find({
      $or: [{ _id: root._id }, { ancestors: root._id }],
      depth: { $lte: root.depth + depth - 1 } // depth counts levels INCLUDING the root
    })
      .select(NODE_FIELDS)
      .lean();

    const byId = new Map(nodes.map((n) => [String(n._id), n]));

    // The scope root's own parent sits outside the fetched subtree, so resolve
    // it separately rather than showing a blank Parent PID on the top node.
    const rootParent = root.parentId
      ? await Associate.findById(root.parentId).select('memberCode').lean()
      : null;

    const parentCodeOf = (node) => {
      if (!node.parentId) return null;
      const key = String(node.parentId);
      if (byId.has(key)) return byId.get(key).memberCode;
      return rootParent && String(rootParent._id) === key ? rootParent.memberCode : null;
    };

    const build = (node) => {
      if (!node) return null;
      const out = toNode(node, parentCodeOf(node));
      const left = node.leftChild && byId.get(String(node.leftChild));
      const right = node.rightChild && byId.get(String(node.rightChild));
      out.left = build(left);
      out.right = build(right);
      // Distinguishes "no member here" from "member exists but beyond the
      // requested depth" — the UI needs that to show an expand affordance.
      out.hasMoreLeft = Boolean(node.leftChild && !left);
      out.hasMoreRight = Boolean(node.rightChild && !right);
      return out;
    };

    return res.status(200).json({
      success: true,
      meta: { rootDepth: root.depth, depth, nodesReturned: nodes.length },
      data: build(root)
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/tree/sponsor/:id?depth=3   — the REFERRAL tree
//
// Same people, different edges: children here are everyone this member
// personally referred (unlimited), not the two they happen to sit above.
// There is no materialised path for sponsorship, so this walks level by level —
// one query per level, not one per node.
// ---------------------------------------------------------------------------
exports.getSponsorTree = async (req, res, next) => {
  try {
    const rootId = req.params.id;
    const depth = parseDepth(req.query.depth);

    const root = await Associate.findById(rootId).select(NODE_FIELDS).lean();
    if (!root) return res.status(404).json({ success: false, message: 'Associate not found' });

    const childrenOf = new Map();
    let frontier = [String(root._id)];
    const seen = new Set(frontier);

    for (let level = 1; level < depth && frontier.length; level++) {
      const query = { sponsorId: { $in: frontier } };
      // A non-admin must not see people outside their own downline, even if a
      // downline member sponsored someone who was later re-placed elsewhere.
      if (req.user.role !== ROLES.ADMIN) query.ancestors = req.user._id;

      const children = await Associate.find(query).select(NODE_FIELDS).lean();
      if (!children.length) break;

      const next = [];
      for (const child of children) {
        const key = String(child.sponsorId);
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key).push(child);

        // Guards against an inherited sponsor cycle turning this into an
        // infinite descent.
        const id = String(child._id);
        if (!seen.has(id)) { seen.add(id); next.push(id); }
      }
      frontier = next;
    }

    const build = (node) => {
      const out = toNode(node);
      out.children = (childrenOf.get(String(node._id)) || []).map(build);
      out.hasMore = out.children.length === 0 && node.directCount > 0;
      return out;
    };

    return res.status(200).json({
      success: true,
      meta: { depth, nodesReturned: seen.size },
      data: build(root)
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/tree/directs/:id   — "My Directs": everyone this member referred.
// ---------------------------------------------------------------------------
exports.getDirects = async (req, res, next) => {
  try {
    const rootId = req.params.id;

    const query = { sponsorId: rootId };
    if (req.user.role !== ROLES.ADMIN) {
      // Normally a direct must sit inside the viewer's own tree. The exception
      // is the viewer's OWN directs who are not placed yet: they have no
      // ancestors to match, and the sponsor needs to see them to place them.
      query.$or = [{ ancestors: req.user._id }];
      if (String(rootId) === String(req.user._id)) {
        query.$or.push({ treeStatus: TREE_STATUSES.UNPLACED });
      }
    }

    const directs = await Associate.find(query).select(NODE_FIELDS).sort({ createdAt: 1 }).lean();

    // Where each direct actually sits, which is the whole point of the view:
    // a direct who spilled over is not the sponsor's own child in the tree.
    const parentIds = directs.map((d) => d.parentId).filter(Boolean);
    const parents = await Associate.find({ _id: { $in: parentIds } }).select('memberCode fullName').lean();
    const parentById = new Map(parents.map((p) => [String(p._id), p]));

    return res.status(200).json({
      success: true,
      count: directs.length,
      data: directs.map((d) => ({
        ...toNode(d),
        placedUnder: d.parentId
          ? {
              memberCode: parentById.get(String(d.parentId))?.memberCode || null,
              fullName: parentById.get(String(d.parentId))?.fullName || null
            }
          : null
      }))
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/tree/upline/:id   — the ancestor chain, for "Up" navigation.
//
// Truncated at the viewer for non-admins. Without that, an associate could
// open a downline member's upline and read every node ABOVE themselves, all
// the way to the root.
// ---------------------------------------------------------------------------
exports.getUpline = async (req, res, next) => {
  try {
    const node = await Associate.findById(req.params.id).select(NODE_FIELDS).lean();
    if (!node) return res.status(404).json({ success: false, message: 'Associate not found' });

    let chain = (node.ancestors || []).map(String);

    if (req.user.role !== ROLES.ADMIN) {
      const viewerIndex = chain.indexOf(String(req.user._id));
      // Everything above the viewer is none of their business.
      chain = viewerIndex === -1 ? [] : chain.slice(viewerIndex);
    }

    const ancestors = await Associate.find({ _id: { $in: chain } }).select(NODE_FIELDS).lean();
    const byId = new Map(ancestors.map((a) => [String(a._id), a]));

    return res.status(200).json({
      success: true,
      count: chain.length,
      // Ordered top-most first, ending at the direct parent.
      data: {
        node: toNode(node),
        upline: chain.map((id) => byId.get(id)).filter(Boolean).map(toNode)
      }
    });
  } catch (error) {
    next(error);
  }
};
