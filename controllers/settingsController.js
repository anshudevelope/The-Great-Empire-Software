const Setting = require('../models/Setting');
const { record, ACTIONS } = require('../services/auditService');
const { SETTING_KEYS } = require('../config/constants');

/**
 * Payout settings — rates, the flush toggle, thresholds.
 *
 * Only the keys below may be written. A generic "write any key" endpoint would
 * let a typo create `payout.adminChargePc` that nothing ever reads, while the
 * real rate silently stays where it was.
 */
const WRITABLE = {
  [SETTING_KEYS.ADMIN_CHARGE_PCT]: {
    label: 'Admin charge',
    parse: (v) => Number(v),
    valid: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
    hint: 'a fraction between 0 and 1 (0.05 = 5%)'
  },
  [SETTING_KEYS.SECONDARY_CHARGE_PCT]: {
    label: 'Second charge',
    parse: (v) => Number(v),
    valid: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
    hint: 'a fraction between 0 and 1 (0.05 = 5%)'
  },
  [SETTING_KEYS.SECONDARY_CHARGE_LABEL]: {
    label: 'Second charge label',
    parse: (v) => String(v).trim(),
    valid: (v) => v.length > 0 && v.length <= 32,
    hint: 'a short name, e.g. TDS'
  },
  [SETTING_KEYS.FLUSH_CARRY_ON_CLOSE]: {
    label: 'Flush carry on close',
    parse: (v) => v === true || v === 'true',
    valid: () => true,
    hint: 'true or false'
  },
  [SETTING_KEYS.MINIMUM_PAYABLE]: {
    label: 'Minimum payable',
    parse: (v) => Number(v),
    valid: (v) => Number.isFinite(v) && v >= 0,
    hint: 'a non-negative amount in rupees'
  },
  [SETTING_KEYS.INCLUDE_ZERO_INCOME]: {
    label: 'Include zero-income members',
    parse: (v) => v === true || v === 'true',
    valid: () => true,
    hint: 'true or false'
  }
};

// GET /api/settings/payout
exports.getPayoutSettings = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await Setting.getAll() });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/settings/payout
 *
 * Every change is audited with its before and after. These values decide what
 * members are paid, and `flushCarryOnClose` decides whether volume is destroyed
 * — "who turned this on?" has to be answerable.
 *
 * Rates are read once when a batch is generated and frozen onto it, so a change
 * here never moves a payout that already exists.
 */
exports.updatePayoutSettings = async (req, res, next) => {
  try {
    const keys = Object.keys(req.body || {}).filter((k) => k in WRITABLE);
    if (!keys.length) {
      return res.status(400).json({
        success: false,
        message: `Nothing to update. Writable keys: ${Object.keys(WRITABLE).join(', ')}`
      });
    }

    const before = await Setting.getAll();
    const applied = {};

    for (const key of keys) {
      const spec = WRITABLE[key];
      const value = spec.parse(req.body[key]);
      if (!spec.valid(value)) {
        return res.status(400).json({
          success: false,
          message: `${spec.label} must be ${spec.hint}.`
        });
      }
      applied[key] = value;
    }

    for (const [key, value] of Object.entries(applied)) {
      await Setting.put(key, value, req.user);
    }

    const after = await Setting.getAll();

    await record(req, {
      action: ACTIONS.SETTINGS_UPDATED,
      targetType: 'Setting',
      targetCode: 'payout',
      before: Object.fromEntries(keys.map((k) => [k, before[k]])),
      after: Object.fromEntries(keys.map((k) => [k, after[k]]))
    });

    res.status(200).json({ success: true, message: 'Payout settings updated.', data: after });
  } catch (error) {
    next(error);
  }
};
