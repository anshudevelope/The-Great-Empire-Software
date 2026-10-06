const { PAYMENT_PLANS, PLOT_PAYMENT, INSTALMENT_KINDS } = require('../../config/plotConfig');
const { round2, httpError } = require('./helpers');

/**
 * The same day N months later, pulled back to the month's last day when that
 * day doesn't exist there (31 Jan + 1 month → 28/29 Feb). Pure.
 */
const addMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1, d.getHours(), d.getMinutes());
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
};

/**
 * Check a requested plan against the switches in plotConfig and the price.
 * Throws a 400 with a message the admin can act on.
 */
const validatePlan = ({ plan, price, downPayment, tenureMonths }) => {
  if (plan === PAYMENT_PLANS.ONE_TIME) {
    if (!PLOT_PAYMENT.oneTime.enabled) throw httpError('One-time payment is not enabled.');
    return;
  }
  if (plan !== PAYMENT_PLANS.EMI) throw httpError('Choose one-time or EMI.');
  if (!PLOT_PAYMENT.emi.enabled) throw httpError('EMI payment is not enabled.');
  if (!PLOT_PAYMENT.emi.tenures.includes(tenureMonths)) {
    throw httpError(`EMI tenure must be one of: ${PLOT_PAYMENT.emi.tenures.join(', ')} months.`);
  }
  if (!(downPayment >= 0)) throw httpError('Down payment cannot be negative.');
  if (downPayment > price) throw httpError('Down payment cannot be more than the plot price.');
  if (downPayment === price) throw httpError('Down payment covers the full price — use one-time payment instead.');
};

/**
 * The instalments for a sale. Pure — no database.
 *
 *   one-time → one FULL row for the whole price, due on the booking date.
 *   EMI      → a DOWN row (skipped when 0), due on the booking date, then N
 *              equal monthly EMIs. Each EMI is the remainder ÷ N rounded to
 *              paise; the LAST one absorbs the rounding so the schedule adds
 *              up to the price exactly. Interest-free (plotConfig).
 *
 * Returns { rows: [{ kind, seq, dueDate, dueAmount }], emiAmount }.
 */
const buildSchedule = ({ plan, price, downPayment = 0, tenureMonths = 0, bookedOn }) => {
  price = round2(price);

  if (plan === PAYMENT_PLANS.ONE_TIME) {
    return {
      emiAmount: 0,
      rows: [{ kind: INSTALMENT_KINDS.FULL, seq: 0, dueDate: new Date(bookedOn), dueAmount: price }]
    };
  }

  const down = round2(downPayment);
  const remainder = round2(price - down);
  const emiAmount = round2(remainder / tenureMonths);

  const rows = [];
  if (down > 0) rows.push({ kind: INSTALMENT_KINDS.DOWN, seq: 0, dueDate: new Date(bookedOn), dueAmount: down });

  for (let i = 1; i <= tenureMonths; i++) {
    const amount = i === tenureMonths ? round2(remainder - emiAmount * (tenureMonths - 1)) : emiAmount;
    rows.push({ kind: INSTALMENT_KINDS.EMI, seq: i, dueDate: addMonths(bookedOn, i), dueAmount: amount });
  }

  return { emiAmount, rows };
};

module.exports = { addMonths, validatePlan, buildSchedule };
