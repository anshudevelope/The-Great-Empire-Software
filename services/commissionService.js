const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const CommissionLedger = require('../models/CommissionLedger');
const {
  COMMISSION_TYPES,
  COMMISSION_RATES,
  CARRY_FIELD,
  VOLUME_FIELD,
  POSITIONS,
  STATUSES,
  TREE_STATUSES,
  REFERRAL_STATUSES,
  TIERS
} = require('../config/constants');

// ---------------------------------------------------------------------------
// Why nothing in this file takes a session
// ---------------------------------------------------------------------------
// Commission runs AFTER the placement transaction has committed, never inside
// it, for two reasons:
//
//   1. withTransaction() retries its callback on SlotTakenError. Commission
//      inside that callback pays out once per attempt.
//   2. A duplicate-key error inside a transaction aborts the whole transaction.
//      Since E11000 is our normal "already paid" signal (§ writeRow), catching
//      and continuing is only possible outside one.
//
// The cost is that placement and payout are not atomic with each other. That is
// bought back by making every write below a single-document atomic operation —
// correct with or without a replica set — plus an idempotency key that makes
// the whole run safe to repeat. scripts/reconcileCommissions.js closes the gap.
// ---------------------------------------------------------------------------

// Rupees, 2dp. Applied once, where the row is built. Rounding at display time
// hides accumulated drift rather than preventing it.
const round2 = (n) => Math.round(n * 100) / 100;

const ratesFor = (tier) => COMMISSION_RATES[tier] || { direct: 0, matching: 0 };

/**
 * Which leg does `member` sit on, as seen from each of their ancestors?
 *
 * `position` only answers this for the DIRECT parent. For anyone higher, the
 * answer is the position of whichever ancestor sits one step further down the
 * chain — that node is the branch the member descends through.
 *
 *   ancestors = [A0(root), A1, A2],  member M (M.parentId === A2)
 *     side vs A2  = M.position         (M is A2's own child)
 *     side vs A1  = A2.position        (M hangs below A2, which is A1's L or R)
 *     side vs A0  = A1.position
 *
 * Pure function — no database, no mongoose documents required. `ordered` must
 * be the ancestor records in the SAME order as `member.ancestors`, i.e. root
 * first, direct parent last.
 *
 * Returns nearest-ancestor-first (see payMatching for why that order matters).
 */
const resolveLegSides = (member, ordered) => {
  const n = ordered.length;
  const out = [];

  for (let i = n - 1; i >= 0; i--) {
    const ancestor = ordered[i];
    // A hole here means an ancestor id had no matching record — a corrupt
    // path. Paying the remaining chain would credit the wrong people, because
    // every side above this point is derived from the missing node's position.
    if (!ancestor) {
      throw new Error(
        `Broken ancestor chain for ${member.memberCode || member._id}: ` +
          `no record at ancestors[${i}]. Run verify:tree before paying commission.`
      );
    }

    const side = i === n - 1 ? member.position : ordered[i + 1].position;
    if (side !== POSITIONS.LEFT && side !== POSITIONS.RIGHT) {
      throw new Error(
        `Cannot resolve leg side for ${member.memberCode || member._id} ` +
          `relative to ancestors[${i}]: position is "${side}".`
      );
    }

    out.push({ ancestor, side, depthFromSource: n - i });
  }

  return out;
};

/**
 * Load a member's ancestor records, in ancestor-array order.
 *
 * find({ _id: { $in } }) returns results in NATURAL order, not argument order.
 * Zipping the raw result against member.ancestors positionally resolves every
 * leg side against the wrong node — which pays correct amounts to the wrong
 * people, silently. The reindex below is not optional.
 */
const reindexChain = (ancestorIds, found) => {
  const byId = new Map(found.map((a) => [String(a._id), a]));
  return ancestorIds.map((id) => byId.get(String(id)));
};

const loadAncestorChain = async (member) => {
  if (!member.ancestors?.length) return [];

  const found = await Associate.find({ _id: { $in: member.ancestors } })
    .select('_id memberCode position tier carryLeft carryRight')
    .lean();

  return reindexChain(member.ancestors, found);
};

/**
 * Insert a ledger row, treating a duplicate key as success.
 *
 * E11000 on idempotencyKey means this exact payment already exists — a retry,
 * a replayed backfill, a double-submitted placement. That is the designed
 * outcome, not an error. Returns null so callers can tell "wrote" from
 * "already there".
 */
const writeRow = async (row) => {
  try {
    const [created] = await CommissionLedger.create([row]);
    return created;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

/**
 * Direct referral bonus — 10%, one level, to the SPONSOR.
 *
 * Paid on member.sponsorId, NOT referral.issuedTo. Those differ whenever the
 * referrer passes sponsorship at placement (IMPLEMENTATION-PLAN §referrals):
 * issuedTo is who paid, sponsorId is who holds the credit. Commission follows
 * credit.
 */
const payDirect = async (member, referral) => {
  if (!member.sponsorId) return null;
  if (String(member.sponsorId) === String(member._id)) return null; // self-sponsor guard
  if (!referral) return null;

  const rate = ratesFor(member.tier).direct;
  const base = referral.amountPaid || 0;
  if (!rate || base <= 0) return null;

  const sponsor = await Associate.findById(member.sponsorId).select('memberCode').lean();
  if (!sponsor) return null;

  const amount = round2(rate * base);

  const created = await writeRow({
    idempotencyKey: `direct:${referral._id}`,
    beneficiary: sponsor._id,
    beneficiaryCode: sponsor.memberCode,
    type: COMMISSION_TYPES.DIRECT,
    tier: member.tier,
    amount,
    sourceMember: member._id,
    sourceMemberCode: member.memberCode,
    sourceReferral: referral._id,
    basis: { rate, base, depthFromSource: null }
  });

  // Only bump the cache when the row is genuinely new — otherwise a replayed
  // backfill inflates the dashboard while the ledger stays correct.
  if (created) {
    await Associate.updateOne({ _id: sponsor._id }, { $inc: { directIncome: amount } });
  }

  return created;
};

/**
 * Binary matching bonus — 5% of min(carryLeft, carryRight), at every ancestor.
 *
 * Walks NEAREST ancestor → root. The order changes no amount (each ancestor's
 * carry is independent) but it makes a partial failure legible: the rows that
 * landed are a contiguous run upward from the member, so a resume knows where
 * it stopped.
 */
const payMatching = async (member, volume) => {
  if (!(volume > 0)) return [];

  const rate = ratesFor(member.tier).matching;
  if (!rate) return [];

  const ordered = await loadAncestorChain(member);
  if (!ordered.length) return []; // the root: nobody above to pay

  const chain = resolveLegSides(member, ordered);
  const written = [];

  for (const { ancestor, side, depthFromSource } of chain) {
    // --- 1. Add the volume, and read the result, in ONE operation ----------
    // Read-then-write loses updates here: two members placed on opposite legs
    // of this same ancestor at the same instant would both observe 0/0, both
    // compute matched = 0, and strand their volume in carry permanently.
    const after = await Associate.findOneAndUpdate(
      { _id: ancestor._id },
      { $inc: { [CARRY_FIELD[side]]: volume, [VOLUME_FIELD[side]]: volume } },
      { new: true, projection: 'memberCode carryLeft carryRight' }
    );
    if (!after) continue; // ancestor vanished mid-run; reconcile will flag it

    const matched = Math.min(after.carryLeft, after.carryRight);
    if (matched <= 0) continue;

    // --- 2. Claim that volume before paying for it ------------------------
    // The guard is what makes this safe without a transaction: if a concurrent
    // placement already consumed the carry, this matches nothing, no-ops, and
    // we skip rather than paying twice on volume someone else was paid for.
    //
    // Deduct BEFORE writing the ledger row, deliberately. If the process dies
    // between the two steps, the failure modes are:
    //   deduct-then-write  → carry consumed, payment unrecorded  (member is
    //                        owed money; reconcile detects it, repairable)
    //   write-then-deduct  → payment recorded twice on one volume (unrecoverable)
    // Failing toward "we owe someone" beats failing toward "we paid twice".
    const deducted = await Associate.findOneAndUpdate(
      {
        _id: ancestor._id,
        carryLeft: { $gte: matched },
        carryRight: { $gte: matched }
      },
      { $inc: { carryLeft: -matched, carryRight: -matched } },
      { new: true, projection: 'carryLeft carryRight' }
    );
    if (!deducted) continue;

    const amount = round2(rate * matched);

    const created = await writeRow({
      idempotencyKey: `match:${ancestor._id}:${member._id}`,
      beneficiary: ancestor._id,
      beneficiaryCode: after.memberCode,
      type: COMMISSION_TYPES.MATCHING,
      tier: member.tier,
      amount,
      sourceMember: member._id,
      sourceMemberCode: member.memberCode,
      sourceReferral: null,
      basis: {
        rate,
        base: matched,
        legSide: side,
        // "Before" = after this member's volume landed, before the match was
        // taken out. That pair of numbers is what explains a match in a dispute.
        carryLeftBefore: after.carryLeft,
        carryRightBefore: after.carryRight,
        carryLeftAfter: deducted.carryLeft,
        carryRightAfter: deducted.carryRight,
        depthFromSource
      }
    });

    if (created) {
      await Associate.updateOne({ _id: ancestor._id }, { $inc: { matchingIncome: amount } });
      written.push(created);
    } else {
      // Duplicate key: this member already paid this ancestor, so the carry we
      // just deducted belongs to that earlier run. Put it back — otherwise a
      // replayed backfill silently eats everyone's carry.
      await Associate.updateOne(
        { _id: ancestor._id },
        { $inc: { carryLeft: matched, carryRight: matched } }
      );
    }
  }

  return written;
};

/**
 * Entry point. Call AFTER the placement transaction commits.
 *
 * Idempotent: safe to call twice, safe to replay from a backfill, safe to call
 * on a member who is not yet eligible (it simply does nothing until they are).
 */
const onPlacement = async (memberId) => {
  const member = await Associate.findById(memberId)
    .select('_id memberCode tier status treeStatus position ancestors sponsorId')
    .lean();

  if (!member) return { skipped: 'member not found' };

  // Not in the tree yet — no leg to add volume to.
  if (member.treeStatus === TREE_STATUSES.UNPLACED) return { skipped: 'unplaced' };

  // Pending/rejected members generate nothing. Deferred until approval, which
  // re-enters here. Paying on a pending member means unwinding a cascade that
  // has already propagated up the tree if they are later rejected.
  if (member.status !== STATUSES.APPROVED) return { skipped: `status: ${member.status}` };

  if (member.tier !== TIERS.ONE) return { skipped: `tier not active: ${member.tier}` };

  const referral = await Referral.findOne({
    member: member._id,
    status: { $in: [REFERRAL_STATUSES.UNUSED, REFERRAL_STATUSES.USED] }
  })
    .select('_id amountPaid')
    .lean();

  // A member placed with no live referral has no money behind them. Record the
  // deliberate zero rather than returning silently, so reconcile can tell
  // "nothing was owed" apart from "the run never happened".
  if (!referral || !(referral.amountPaid > 0)) {
    await writeRow({
      idempotencyKey: `direct:none:${member._id}`,
      beneficiary: member._id,
      beneficiaryCode: member.memberCode,
      type: COMMISSION_TYPES.DIRECT,
      tier: member.tier,
      amount: 0,
      sourceMember: member._id,
      sourceMemberCode: member.memberCode,
      basis: { rate: 0, base: 0 },
      note: referral ? 'referral has no amountPaid — no commission base' : 'no live referral — no commission base'
    });
    return { direct: null, matching: [], note: 'no commission base' };
  }

  const direct = await payDirect(member, referral);
  const matching = await payMatching(member, referral.amountPaid);

  return { direct, matching };
};

/**
 * Reverse a ledger row by writing its negative, never by editing or deleting it.
 *
 * The ledger is append-only: "what was paid" and "what was later taken back"
 * are both facts, and an edited row destroys the first one. A reversal row
 * carries the negative amount and points at the original through `reversalOf`.
 *
 * Deliberately does NOT touch carry. A matching row consumed carry that has
 * since matched against other volume further up the tree — putting it back
 * would let that volume pay twice. See COMMISSION-ENGINE-PLAN.md §7.3.
 */
const reverseRow = async (ledgerId, { reason = '' } = {}) => {
  const original = await CommissionLedger.findById(ledgerId).lean();
  if (!original) {
    const err = new Error('Commission row not found.');
    err.status = 404;
    throw err;
  }
  if (original.type === COMMISSION_TYPES.REVERSAL) {
    const err = new Error('A reversal cannot itself be reversed.');
    err.status = 400;
    throw err;
  }
  if (original.amount === 0) {
    const err = new Error('That row is a zero-value marker — there is nothing to reverse.');
    err.status = 400;
    throw err;
  }

  const created = await writeRow({
    idempotencyKey: `reversal:${original._id}`,
    beneficiary: original.beneficiary,
    beneficiaryCode: original.beneficiaryCode,
    type: COMMISSION_TYPES.REVERSAL,
    tier: original.tier,
    amount: -original.amount,
    sourceMember: original.sourceMember,
    sourceMemberCode: original.sourceMemberCode,
    sourceReferral: original.sourceReferral,
    basis: { rate: original.basis.rate, base: original.basis.base },
    reversalOf: original._id,
    note: reason
  });

  if (!created) {
    const err = new Error('That row has already been reversed.');
    err.status = 409;
    throw err;
  }

  // Unwind the cache the original row bumped.
  const field = original.type === COMMISSION_TYPES.DIRECT ? 'directIncome' : 'matchingIncome';
  await Associate.updateOne({ _id: original.beneficiary }, { $inc: { [field]: -original.amount } });

  return { original, reversal: created };
};

/**
 * onPlacement that never throws.
 *
 * By the time this runs the placement has already committed. Letting a
 * commission failure bubble would turn a successful placement into a 500 and
 * invite the operator to retry it — re-placing a member who is already in the
 * tree. Log it and move on; the run is idempotent, so
 * scripts/reconcileCommissions.js can replay it safely.
 */
const settle = async (memberId, context = '') => {
  try {
    return await onPlacement(memberId);
  } catch (err) {
    console.error(
      `[commission] settle failed for ${memberId}${context ? ` (${context})` : ''}: ${err.message}\n` +
        '  Placement stands. Re-run: npm run reconcile:commissions'
    );
    return { error: err.message };
  }
};

/**
 * Has this member — or anyone beneath them — already generated commission?
 *
 * Moving a node moves its whole subtree's volume from one ancestor's leg to
 * another's, but matches already paid on that volume cannot be un-paid: the
 * carry they consumed has since been matched against other volume further up.
 * Re-attribution is a rebuild, not an inline edit, so the move is refused
 * instead (COMMISSION-ENGINE-PLAN.md §7.2).
 */
const subtreeHasCommission = async (memberId) => {
  const descendants = await Associate.find({ ancestors: memberId }).distinct('_id');
  return CommissionLedger.countDocuments({
    sourceMember: { $in: [memberId, ...descendants] },
    amount: { $gt: 0 }
  });
};

module.exports = {
  onPlacement,
  settle,
  reverseRow,
  subtreeHasCommission,
  payDirect,
  payMatching,
  resolveLegSides,
  reindexChain,
  loadAncestorChain,
  writeRow,
  round2,
  ratesFor
};
