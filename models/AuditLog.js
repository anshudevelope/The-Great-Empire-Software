const mongoose = require('mongoose');

/**
 * Append-only record of financially sensitive actions.
 *
 * Tree moves, approvals and voucher lifecycle events all change who earns what.
 * When a dispute arrives months later ("I was moved", "that voucher was already
 * used"), this is the only thing that can reconstruct what happened and who did
 * it — the documents themselves only show the current state.
 */
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    actorCode: { type: String, default: null },
    actorRole: { type: String, default: null },

    targetType: { type: String, default: null }, // 'Associate' | 'Referral'
    target: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetCode: { type: String, default: null },

    // Free-form snapshots. Deliberately loose: an audit row must keep whatever
    // was relevant at the time, even if the schema later changes.
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },

    ip: { type: String, default: null },
    note: { type: String, default: '' }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ target: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
