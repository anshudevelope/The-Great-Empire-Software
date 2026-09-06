const Associate = require('../models/Associate');
const { ROLES } = require('../config/constants');

/**
 * The single place scoping is applied.
 *
 * Every report goes through here. The most common way an MLM system leaks its
 * genealogy is one report route that forgot the scope, so the rule is: no
 * controller builds its own base filter.
 *
 * - admin, no target  → company-wide
 * - admin, target     → that member's downline
 * - associate         → only their own subtree (the route's scopeToDownline
 *                       middleware has already proven the target is inside it)
 */
const resolveScopeRoot = async (viewer, targetId) => {
  if (targetId) {
    const root = await Associate.findById(targetId).select('memberCode fullName depth leftChild rightChild directCount tier status');
    if (!root) {
      const err = new Error('Associate not found.');
      err.status = 404;
      throw err;
    }
    return root;
  }

  if (viewer.role === ROLES.ADMIN) return null; // company-wide

  return Associate.findById(viewer._id).select('memberCode fullName depth leftChild rightChild directCount tier status');
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Base filter for "everyone below `root`" (or everyone, for a company-wide
 * admin view), plus the optional report filters.
 */
const buildScopedFilter = (root, query = {}) => {
  const filter = { role: ROLES.ASSOCIATE };

  if (root) filter.ancestors = root._id;

  const { status, tier, from, to, search, leg, minDepth, maxDepth } = query;

  if (status) filter.status = status;
  if (tier) filter.tier = tier;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ fullName: rx }, { email: rx }, { phone: rx }, { memberCode: rx }];
  }

  // Depth here is absolute (distance from the tree root), which is what the
  // stored field holds. Relative depth is computed per-report where needed.
  if (minDepth || maxDepth) {
    filter.depth = {};
    if (minDepth) filter.depth.$gte = Number(minDepth);
    if (maxDepth) filter.depth.$lte = Number(maxDepth);
  }

  // Restrict to one leg of the scope root: the member sitting in that slot,
  // plus everyone beneath them.
  if (leg && root) {
    const legRoot = leg === 'Left' ? root.leftChild : root.rightChild;
    if (!legRoot) {
      // Empty leg — match nothing rather than silently returning the whole tree.
      filter._id = null;
    } else {
      delete filter.ancestors;
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ _id: legRoot }, { ancestors: legRoot }] }
      ];
    }
  }

  return filter;
};

const parsePaging = (query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 25));
  const sortField = ['createdAt', 'memberCode', 'depth', 'fullName', 'directCount'].includes(query.sortBy)
    ? query.sortBy
    : 'createdAt';
  const sortDir = query.sortDir === 'asc' ? 1 : -1;
  return { page, limit, skip: (page - 1) * limit, sort: { [sortField]: sortDir } };
};

module.exports = { resolveScopeRoot, buildScopedFilter, parsePaging, escapeRegex };
