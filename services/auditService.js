const AuditLog = require('../models/AuditLog');

const ACTIONS = {
  MEMBER_REGISTERED: 'member.registered',
  // A member entering the tree for the first time (by admin or sponsor).
  MEMBER_PLACED: 'member.placed',
  MEMBER_STATUS_CHANGED: 'member.status_changed',
  MEMBER_MOVED: 'member.moved',
  MEMBER_SPONSOR_CHANGED: 'member.sponsor_changed',
  MEMBER_DELETED: 'member.deleted',
  REFERRAL_ISSUED: 'referral.issued',
  REFERRAL_UPDATED: 'referral.updated',
  REFERRAL_CANCELLED: 'referral.cancelled',
  COMMISSION_REVERSED: 'commission.reversed',
  // Closing the books. PAYOUT_FINALIZED is the single most consequential action
  // in the system: it pays everyone, resets their income, and destroys carry
  // that cannot be reconstructed.
  PAYOUT_GENERATED: 'payout.generated',
  PAYOUT_FINALIZED: 'payout.finalized',
  PAYOUT_CANCELLED: 'payout.cancelled',
  PAYOUT_DISCARDED: 'payout.discarded',
  SETTINGS_UPDATED: 'settings.updated',
  PASSWORD_CHANGED: 'auth.password_changed',
  PASSWORD_SET_BY_ADMIN: 'auth.password_set_by_admin'
};

/**
 * Records an action. Deliberately never throws: an audit failure must not roll
 * back or 500 the business operation that succeeded. A lost log line is bad;
 * a failed registration because logging broke is worse.
 */
const record = async (req, { action, targetType, target, targetCode, before, after, note }) => {
  try {
    await AuditLog.create({
      action,
      actor: req.user?._id ?? null,
      actorCode: req.user?.memberCode ?? null,
      actorRole: req.user?.role ?? null,
      targetType: targetType ?? null,
      target: target ?? null,
      targetCode: targetCode ?? null,
      before: before ?? null,
      after: after ?? null,
      ip: req.ip ?? null,
      note: note ?? ''
    });
  } catch (error) {
    console.error('[audit] failed to record', action, error.message);
  }
};

module.exports = { record, ACTIONS };
