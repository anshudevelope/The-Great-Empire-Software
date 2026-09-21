const mongoose = require('mongoose');
const PayoutBatch = require('../models/PayoutBatch');
const PayoutLine = require('../models/PayoutLine');
const payoutService = require('../services/payoutService');
const { record, ACTIONS } = require('../services/auditService');
const { streamCsv } = require('../utils/csv');
const { PAYOUT_STATUSES } = require('../config/constants');

const MAX_LIMIT = 500;

const parsePaging = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

// Service errors carry a .status; anything else is a genuine fault and belongs
// with the error handler, stack trace and all.
const fail = (res, next, error) => {
  if (error.status) return res.status(error.status).json({ success: false, message: error.message });
  return next(error);
};

// ---------------------------------------------------------------------------
// 1. GET /api/payouts — previous payouts
// ---------------------------------------------------------------------------
exports.getBatches = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const filter = {};
    if (req.query.status && Object.values(PAYOUT_STATUSES).includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const [batches, total] = await Promise.all([
      PayoutBatch.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('generatedBy finalizedBy cancelledBy', 'fullName memberCode')
        .lean(),
      PayoutBatch.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: batches,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 2. GET /api/payouts/draft — the open draft, if there is one
//
// The Create Payout page calls this on load. Without it the page would have to
// POST a new draft to find out one already exists, and get a 409 for its
// trouble.
// ---------------------------------------------------------------------------
exports.getDraft = async (req, res, next) => {
  try {
    const batch = await PayoutBatch.findOne({ status: PAYOUT_STATUSES.DRAFT })
      .populate('generatedBy', 'fullName memberCode')
      .lean();

    if (!batch) {
      // Not an error — "no draft open" is the normal state. Include what the
      // next batch would cover so the page can show its date range.
      const [periodStart, rates, last] = await Promise.all([
        payoutService.resolvePeriodStart(),
        payoutService.currentRates(),
        // The last closing, so the page can warn when a hand-picked start date
        // reaches back into a period that has already been paid.
        PayoutBatch.findOne({ status: PAYOUT_STATUSES.FINALIZED })
          .sort({ periodEnd: -1 })
          .select('batchNo periodStart periodEnd finalizedAt')
          .lean()
      ]);

      return res.status(200).json({
        success: true,
        data: null,
        next: {
          periodStart,
          rates,
          previous: last
            ? {
                batchNo: last.batchNo,
                periodStart: last.periodStart,
                periodEnd: last.periodEnd,
                finalizedAt: last.finalizedAt
              }
            : null
        }
      });
    }

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 3. POST /api/payouts/preview — build a draft
//
// Writes the batch and its lines and nothing else: no ledger row is stamped and
// no member is touched, so this is safe to run and throw away.
// ---------------------------------------------------------------------------
exports.createDraft = async (req, res, next) => {
  try {
    const batch = await payoutService.generateDraft({
      periodStart: req.body.periodStart,
      periodEnd: req.body.periodEnd,
      actor: req.user,
      note: req.body.note || ''
    });

    await record(req, {
      action: ACTIONS.PAYOUT_GENERATED,
      targetType: 'PayoutBatch',
      target: batch._id,
      targetCode: batch.batchNo,
      after: {
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        gross: batch.totals.gross,
        netPayable: batch.totals.netPayable,
        members: batch.totals.members
      }
    });

    res.status(201).json({ success: true, message: `Draft ${batch.batchNo} created.`, data: batch });
  } catch (error) {
    fail(res, next, error);
  }
};

// ---------------------------------------------------------------------------
// 4. POST /api/payouts/:id/finalize
// ---------------------------------------------------------------------------
exports.finalize = async (req, res, next) => {
  try {
    const { batch, stampedRows } = await payoutService.finalizeBatch(req.params.id, req.user);

    await record(req, {
      action: ACTIONS.PAYOUT_FINALIZED,
      targetType: 'PayoutBatch',
      target: batch._id,
      targetCode: batch.batchNo,
      after: {
        netPayable: batch.totals.netPayable,
        members: batch.totals.members,
        // The destructive part. Recorded explicitly because it cannot be
        // recomputed from anything else afterwards.
        carryFlushed: batch.totals.carryFlushed,
        stampedRows
      }
    });

    res.status(200).json({
      success: true,
      message: `${batch.batchNo} finalized. ${batch.totals.netPayable} payable to ${batch.totals.members} member(s).`,
      data: batch
    });
  } catch (error) {
    fail(res, next, error);
  }
};

// ---------------------------------------------------------------------------
// 5. POST /api/payouts/:id/cancel
// ---------------------------------------------------------------------------
exports.cancel = async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A reason is required to cancel a finalized payout.'
      });
    }

    const batch = await payoutService.cancelBatch(req.params.id, req.user, reason);

    await record(req, {
      action: ACTIONS.PAYOUT_CANCELLED,
      targetType: 'PayoutBatch',
      target: batch._id,
      targetCode: batch.batchNo,
      before: { netPayable: batch.totals.netPayable, carryFlushed: batch.totals.carryFlushed },
      note: reason
    });

    res.status(200).json({
      success: true,
      message: `${batch.batchNo} cancelled. Income and carry restored.`,
      data: batch
    });
  } catch (error) {
    fail(res, next, error);
  }
};

// ---------------------------------------------------------------------------
// 6. DELETE /api/payouts/:id — discard a draft
// ---------------------------------------------------------------------------
exports.discard = async (req, res, next) => {
  try {
    const batch = await payoutService.discardDraft(req.params.id);

    await record(req, {
      action: ACTIONS.PAYOUT_DISCARDED,
      targetType: 'PayoutBatch',
      target: batch._id,
      targetCode: batch.batchNo
    });

    res.status(200).json({ success: true, message: `Draft ${batch.batchNo} discarded.` });
  } catch (error) {
    fail(res, next, error);
  }
};

// ---------------------------------------------------------------------------
// 7. GET /api/payouts/:id — one batch
// ---------------------------------------------------------------------------
exports.getBatch = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid payout id.' });
    }

    const batch = await PayoutBatch.findById(req.params.id)
      .populate('generatedBy finalizedBy cancelledBy', 'fullName memberCode')
      .lean();

    if (!batch) return res.status(404).json({ success: false, message: 'Payout not found.' });

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 8. GET /api/payouts/:id/lines  (?format=csv to download)
// ---------------------------------------------------------------------------
exports.getLines = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid payout id.' });
    }

    const batch = await PayoutBatch.findById(req.params.id).lean();
    if (!batch) return res.status(404).json({ success: false, message: 'Payout not found.' });

    const filter = { batch: batch._id };
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ memberCode: rx }, { fullName: rx }, { pan: rx }];
    }
    // The zero rows are noise on screen; the admin can ask for them explicitly.
    if (req.query.nonZero === 'true') filter.total = { $ne: 0 };

    if (req.query.format === 'csv') {
      // The second charge is named per batch, so the header follows the rates
      // frozen onto it rather than whatever the setting says today.
      const label = batch.rates.secondaryChargeLabel || 'TDS';
      let sno = 0;
      const columns = [
        { header: 'Sno.', value: () => ++sno },
        { header: 'MemberCode', value: (d) => d.memberCode },
        { header: 'Name', value: (d) => d.fullName },
        { header: 'PAN', value: (d) => d.pan || '' },
        { header: 'Tier', value: (d) => d.tier },
        { header: 'Direct (10%)', value: (d) => d.direct },
        { header: 'Matching (5%)', value: (d) => d.matching },
        { header: 'Reversals', value: (d) => d.reversals },
        { header: 'Brought Forward', value: (d) => d.openingAdjustment },
        { header: 'Total', value: (d) => d.total },
        { header: `Admin Charge (${batch.rates.adminChargePct * 100}%)`, value: (d) => d.adminCharge },
        { header: `${label} (${batch.rates.secondaryChargePct * 100}%)`, value: (d) => d.secondaryCharge },
        { header: 'Net Payable', value: (d) => d.netPayable },
        { header: 'Held', value: (d) => d.heldReason || '' },
        { header: 'Carry Flushed L', value: (d) => d.carryFlushed?.left ?? 0 },
        { header: 'Carry Flushed R', value: (d) => d.carryFlushed?.right ?? 0 }
      ];

      const cursor = PayoutLine.find(filter).sort({ memberCode: 1 }).cursor();
      return streamCsv(res, `${batch.batchNo}-payout.csv`, columns, cursor);
    }

    const { page, limit, skip } = parsePaging(req.query);
    const [lines, total] = await Promise.all([
      PayoutLine.find(filter).sort({ memberCode: 1 }).skip(skip).limit(limit).lean(),
      PayoutLine.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      batch: { batchNo: batch.batchNo, status: batch.status, rates: batch.rates, totals: batch.totals },
      data: lines,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// 9. GET /api/payouts/me — the caller's own payout history
//
// FINALIZED batches only. A draft may still be discarded and a cancelled batch
// was never paid; showing either would tell a member they have money coming
// when they do not.
// ---------------------------------------------------------------------------
exports.getMyPayouts = async (req, res, next) => {
  try {
    const finalized = await PayoutBatch.find({ status: PAYOUT_STATUSES.FINALIZED })
      .select('_id batchNo periodStart periodEnd finalizedAt rates')
      .sort({ periodEnd: -1 })
      .lean();

    if (!finalized.length) return res.status(200).json({ success: true, data: [], total: 0 });

    const byId = new Map(finalized.map((b) => [String(b._id), b]));
    const lines = await PayoutLine.find({
      member: req.user._id,
      batch: { $in: finalized.map((b) => b._id) }
    })
      .sort({ createdAt: -1 })
      .lean();

    const data = lines.map((l) => {
      const b = byId.get(String(l.batch));
      return {
        batchNo: l.batchNo,
        periodStart: b?.periodStart ?? null,
        periodEnd: b?.periodEnd ?? null,
        paidOn: b?.finalizedAt ?? null,
        secondaryChargeLabel: b?.rates?.secondaryChargeLabel ?? 'TDS',
        direct: l.direct,
        matching: l.matching,
        reversals: l.reversals,
        openingAdjustment: l.openingAdjustment,
        total: l.total,
        adminCharge: l.adminCharge,
        secondaryCharge: l.secondaryCharge,
        netPayable: l.netPayable,
        heldReason: l.heldReason,
        carryFlushed: l.carryFlushed
      };
    });

    res.status(200).json({
      success: true,
      data,
      total: payoutService.round2(data.reduce((sum, d) => sum + d.netPayable, 0))
    });
  } catch (error) {
    next(error);
  }
};
