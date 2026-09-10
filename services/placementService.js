const Associate = require('../models/Associate');
const { POSITIONS, TREE_STATUSES } = require('../config/constants');
const { SlotTakenError } = require('../utils/transaction');

// Defensive ceiling for any tree walk. If a cycle ever reaches the data — a bad
// migration, a manual DB edit — an unbounded walk would spin forever, and since
// Node is single-threaded that hangs the entire API, not just one request.
const MAX_WALK = 10000;

const childField = (position) => (position === POSITIONS.LEFT ? 'leftChild' : 'rightChild');

const httpError = (message, status) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/**
 * Spillover: walk down the chosen leg until an open slot is found.
 *
 * This is what makes sponsor ≠ parent. A sponsor whose leg is full doesn't
 * block the registration — the new member slides down to the outermost free
 * position on that side, while the sponsor relationship stays put.
 */
const findExtremeNode = async (startParentId, position, session = null) => {
  let currentParent = await Associate.findById(startParentId).session(session);
  const seen = new Set();

  while (currentParent) {
    const key = String(currentParent._id);
    if (seen.has(key)) {
      throw new Error(`Tree cycle detected at ${currentParent.memberCode || key}`);
    }
    seen.add(key);
    if (seen.size > MAX_WALK) throw new Error('Tree walk exceeded maximum depth.');

    const nextChildId = currentParent[childField(position)];
    if (!nextChildId) return currentParent._id;
    currentParent = await Associate.findById(nextChildId).session(session);
  }
  return startParentId;
};

/**
 * Resolve the parent an associate should actually attach under, spilling down
 * the leg if the requested slot is taken. `selfId` (only set when re-placing an
 * existing associate) stops it spilling away from a slot it already occupies.
 */
const resolveTreeTarget = async (requestedParentId, requestedPosition, selfId = null, session = null) => {
  if (![POSITIONS.LEFT, POSITIONS.RIGHT].includes(requestedPosition)) {
    throw httpError('Position must be either "Left" or "Right".', 400);
  }

  const parentNode = await Associate.findById(requestedParentId).session(session);
  if (!parentNode) throw httpError('Specified Parent node not found.', 404);

  const existingChild = parentNode[childField(requestedPosition)];
  const slotIsSelf = existingChild && selfId && String(existingChild) === String(selfId);

  if (existingChild && !slotIsSelf) {
    return findExtremeNode(requestedParentId, requestedPosition, session);
  }
  return requestedParentId;
};

/**
 * Claim a tree slot, but ONLY if it is still empty.
 *
 * The conditional filter is the whole point. An unconditional update lets two
 * concurrent registrations that resolved to the same empty slot overwrite each
 * other — the second silently orphans the first. Returning null here means
 * "someone beat us"; the caller re-resolves and retries.
 */
const claimSlot = async (parentId, position, childId, session = null) => {
  const field = childField(position);
  return Associate.findOneAndUpdate(
    { _id: parentId, [field]: null },
    { [field]: childId },
    { new: true, session }
  );
};

// Clear a parent's child pointer, but only if it still points at childId —
// guards against clobbering a slot that has since been reassigned.
const detachFromParent = async (parentId, position, childId, session = null) => {
  if (!parentId || !position || !childId) return;
  await Associate.findOneAndUpdate(
    { _id: parentId, [childField(position)]: childId },
    { [childField(position)]: null },
    { session }
  );
};

/**
 * A move isn't finished when parentId changes: every descendant's ancestors and
 * depth are now stale. The tree would still RENDER correctly (that walks
 * leftChild/rightChild) while every downline report silently returned wrong
 * results — so re-path the whole subtree.
 */
const repathSubtree = async (node, newParentDoc, session = null) => {
  const oldPrefixLength = node.ancestors.length + 1; // [...node.ancestors, node._id]
  const newAncestors = newParentDoc ? [...newParentDoc.ancestors, newParentDoc._id] : [];
  const newPrefix = [...newAncestors, node._id];
  const newDepth = newParentDoc ? newParentDoc.depth + 1 : 0;
  const depthDelta = newDepth - node.depth;

  const descendants = await Associate.find({ ancestors: node._id }).select('ancestors depth').session(session);

  if (descendants.length) {
    await Associate.bulkWrite(
      descendants.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: {
              ancestors: [...newPrefix, ...d.ancestors.slice(oldPrefixLength)],
              depth: d.depth + depthDelta
            }
          }
        }
      })),
      { session }
    );
  }

  return { ancestors: newAncestors, depth: newDepth };
};

/**
 * Create a member and attach them to the tree in one go.
 *
 * Must run inside withTransaction() so that a SlotTakenError rolls the member
 * creation back rather than leaving an unattached record behind.
 */
const createAndPlace = async ({ memberData, requestedParentId, position }, session = null) => {
  let ancestors = [];
  let depth = 0;
  let targetParentId = null;

  if (requestedParentId) {
    targetParentId = await resolveTreeTarget(requestedParentId, position, null, session);

    const parent = await Associate.findById(targetParentId).select('ancestors depth').session(session);
    if (!parent) throw httpError('Resolved parent node not found.', 404);

    // Path is derived from the RESOLVED parent (after spillover), never the
    // requested one.
    ancestors = [...parent.ancestors, parent._id];
    depth = parent.depth + 1;
  }

  const [member] = await Associate.create(
    [
      {
        ...memberData,
        parentId: targetParentId,
        position: targetParentId ? position : null,
        ancestors,
        depth,
        // With a parent they're placed; without one the caller decides whether
        // this is the tree root or simply not placed yet.
        treeStatus: targetParentId ? TREE_STATUSES.PLACED : memberData.treeStatus || TREE_STATUSES.UNPLACED
      }
    ],
    { session }
  );

  if (targetParentId) {
    const claimed = await claimSlot(targetParentId, position, member._id, session);
    if (!claimed) throw new SlotTakenError();
  }

  return member;
};

/**
 * Put an EXISTING associate into the tree.
 *
 * The counterpart to createAndPlace: the member already exists as a record and
 * is simply taking up a node.
 *
 * `exact: false` spills down the leg when the slot is taken. `exact: true` is
 * for when the caller chose a specific parent — landing somewhere else would
 * silently ignore that choice, so a taken slot is a 409 instead.
 *
 * `extra` fields are saved on the member in the same write (e.g. status).
 *
 * Must run inside withTransaction() so a failure rolls the whole thing back
 * rather than half-placing the member.
 */
const placeExisting = async ({ memberId, requestedParentId, position, exact = false, extra = {} }, session = null) => {
  const member = await Associate.findById(memberId).session(session);
  if (!member) throw httpError('Associate not found.', 404);

  if (member.treeStatus !== TREE_STATUSES.UNPLACED) {
    throw httpError(`${member.memberCode} is already in the tree.`, 409);
  }

  if (![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
    throw httpError('Position must be either "Left" or "Right".', 400);
  }

  const targetParentId = exact
    ? requestedParentId
    : await resolveTreeTarget(requestedParentId, position, null, session);

  // Placing someone under their own descendant is impossible here (an unplaced
  // member has no descendants), but the target must still not be the member.
  if (String(targetParentId) === String(member._id)) {
    throw httpError('An associate cannot be placed under themselves.', 400);
  }

  const parent = await Associate.findById(targetParentId).select('ancestors depth memberCode').session(session);
  if (!parent) throw httpError('Resolved parent node not found.', 404);

  const claimed = await claimSlot(targetParentId, position, member._id, session);
  if (!claimed) {
    // Retrying an exact placement can't help — the chosen slot is gone.
    if (exact) {
      throw httpError(`${parent.memberCode}'s ${position} leg is already taken. Choose another leg or parent.`, 409);
    }
    throw new SlotTakenError();
  }

  Object.assign(member, extra);
  member.parentId = targetParentId;
  member.position = position;
  member.ancestors = [...parent.ancestors, parent._id];
  member.depth = parent.depth + 1;
  member.treeStatus = TREE_STATUSES.PLACED;
  await member.save({ session });

  return { member, parent };
};

/**
 * Where would a new member actually land? Powers the "Will be placed under
 * TRG0098 (3 levels below you)" line on the registration form, so the
 * associate can see the spillover result before committing.
 */
const previewPlacement = async (rootId, position) => {
  if (![POSITIONS.LEFT, POSITIONS.RIGHT].includes(position)) {
    throw httpError('Position must be either "Left" or "Right".', 400);
  }

  const root = await Associate.findById(rootId).select('memberCode fullName depth');
  if (!root) throw httpError('Associate not found.', 404);

  const targetId = await resolveTreeTarget(rootId, position, null, null);
  const target = await Associate.findById(targetId).select('memberCode fullName depth');

  return {
    parent: { _id: target._id, memberCode: target.memberCode, fullName: target.fullName },
    position,
    depth: target.depth + 1,
    levelsBelow: target.depth + 1 - root.depth,
    isDirect: String(targetId) === String(rootId)
  };
};

module.exports = {
  findExtremeNode,
  resolveTreeTarget,
  claimSlot,
  detachFromParent,
  repathSubtree,
  createAndPlace,
  placeExisting,
  previewPlacement,
  childField,
  httpError
};
