const { PAYMENT_PLANS, PLOT_PAYMENT, INSTALMENT_KINDS, PAYMENT_ADJUSTMENTS } = require('../../config/plotConfig');
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

// ---------------------------------------------------------------------------
// Payments against a schedule. Money is handled in paise here so sums never
// drift; results come back in rupees.
// ---------------------------------------------------------------------------
const toPaise = (n) => Math.round((Number(n) || 0) * 100);
const fromPaise = (p) => p / 100;
const owedOf = (row) => Math.max(0, toPaise(row.dueAmount) - toPaise(row.paidAmount));
const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};
const lastOf = (list) => list[list.length - 1];

/** Pay rows in order until the money (paise) runs out. Pure. */
const fillRows = (rows, paise) => {
  let left = paise;
  const fills = [];
  for (const row of rows) {
    if (left <= 0) break;
    const take = Math.min(owedOf(row), left);
    if (take <= 0) continue;
    fills.push({ row, amount: fromPaise(take) });
    left -= take;
  }
  return { fills, left };
};

/**
 * Replacement EMIs after a prepayment. `slots` are the future EMI rows being
 * replaced (their seq and due date, in order); `balance` is what is left to
 * pay on them, in paise.
 *   reduce_emi    → every slot, a smaller EMI.
 *   reduce_tenure → the current EMI on as few slots as needed.
 * The last row absorbs the rounding. Pure.
 */
const reshape = ({ slots, balance, mode, emiAmount }) => {
  const row = (slot, paise) => ({ kind: INSTALMENT_KINDS.EMI, seq: slot.seq, dueDate: slot.dueDate, dueAmount: fromPaise(paise) });

  if (mode === PAYMENT_ADJUSTMENTS.REDUCE_EMI) {
    const each = Math.floor(balance / slots.length);
    // Less than a paisa per row: one row carries it, rather than ₹0 EMIs.
    if (each === 0) return [row(slots[0], balance)];
    return slots.map((s, i) => row(s, i === slots.length - 1 ? balance - each * (slots.length - 1) : each));
  }

  const emi = Math.max(1, toPaise(emiAmount));
  const count = Math.min(slots.length, Math.ceil(balance / emi));
  return slots.slice(0, count).map((s, i) => row(s, i === count - 1 ? balance - emi * (count - 1) : emi));
};

/**
 * Where one payment lands on a booking. Pure — the receipt service writes the
 * result, the preview endpoint only returns it.
 *
 *   1. Everything due by the payment date, oldest first; a shortfall leaves
 *      the last instalment touched partial.
 *   2. Any extra: the whole balance closes the booking; otherwise the admin's
 *      choice — pay the next instalments, or reshape them (reduce EMI/tenure).
 *
 * `rows` are the booking's open instalments (due / partial) by seq. When the
 * extra needs a choice that was not given, needsChoice is true instead of an
 * error: the preview shows the choice, recording refuses.
 */
const planPayment = ({ booking, rows, amount, paidOn, adjustment = null }) => {
  const balance = Math.max(0, toPaise(booking.price) - toPaise(booking.paidTotal));
  const paise = toPaise(amount);
  if (!(paise > 0)) throw httpError('Amount must be more than 0.');
  if (paise > balance) {
    throw httpError(`Amount cannot be more than the balance of ₹${fromPaise(balance).toLocaleString('en-IN')}.`);
  }
  if (adjustment && !Object.values(PAYMENT_ADJUSTMENTS).includes(adjustment)) {
    throw httpError('Unknown way to apply the extra amount.');
  }

  const cutoff = endOfDay(paidOn);
  const dueNowRows = rows.filter((r) => new Date(r.dueDate) <= cutoff);
  const future = rows.filter((r) => new Date(r.dueDate) > cutoff);
  const first = fillRows(dueNowRows, paise);

  const plan = {
    balance: fromPaise(balance),
    dueNow: fromPaise(dueNowRows.reduce((s, r) => s + owedOf(r), 0)),
    extra: fromPaise(first.left),
    fills: first.fills,
    needsChoice: false,
    adjustment: null,
    prepayment: 0,
    supersede: [],
    newRows: [],
    balanceAfter: fromPaise(balance - paise),
    completes: balance - paise === 0
  };
  if (first.left === 0) return plan;

  const futureOwed = future.reduce((s, r) => s + owedOf(r), 0);
  const payAhead = () => {
    const rest = fillRows(future, first.left);
    if (rest.left > 0) throw httpError('This booking\'s schedule does not add up to its balance — run npm run verify:plots.', 409);
    plan.fills = [...plan.fills, ...rest.fills];
  };

  // The whole balance: pay everything left, nothing to choose.
  if (first.left >= futureOwed) {
    payAhead();
    return plan;
  }
  if (!adjustment) {
    plan.needsChoice = true;
    return plan;
  }

  if (adjustment === PAYMENT_ADJUSTMENTS.PAY_AHEAD) {
    payAhead();
    plan.adjustment = { type: adjustment, extra: plan.extra, before: null, after: null };
    return plan;
  }

  if (future.some((r) => r.kind !== INSTALMENT_KINDS.EMI)) {
    throw httpError('Only EMIs can be reshaped — choose "Pay upcoming EMIs" instead.');
  }
  // A future EMI part-paid by an earlier pay-ahead is finished first, so the
  // extra never lands on the other EMIs while that one still owes money.
  // Only what is left after it reshapes the unpaid EMIs.
  let left = first.left;
  const partial = future.find((r) => toPaise(r.paidAmount) > 0) || null;
  if (partial) {
    const take = Math.min(owedOf(partial), left);
    plan.fills = [...plan.fills, { row: partial, amount: fromPaise(take) }];
    left -= take;
  }
  if (left === 0) {
    // All of it went into that EMI — nothing left to reshape.
    plan.adjustment = { type: PAYMENT_ADJUSTMENTS.PAY_AHEAD, extra: plan.extra, before: null, after: null };
    return plan;
  }

  const slots = future.filter((r) => r !== partial);
  if (!slots.length) throw httpError('No upcoming EMIs are left to reshape — choose "Pay upcoming EMIs" instead.');
  const slotsOwed = slots.reduce((s, r) => s + owedOf(r), 0);

  const newRows = reshape({ slots, balance: slotsOwed - left, mode: adjustment, emiAmount: booking.emiAmount });
  plan.prepayment = fromPaise(left);
  plan.supersede = slots;
  plan.newRows = newRows;
  plan.adjustment = {
    type: adjustment,
    extra: plan.prepayment,
    before: { count: slots.length, emi: booking.emiAmount, endDate: lastOf(slots).dueDate },
    after: { count: newRows.length, emi: newRows[0].dueAmount, endDate: lastOf(newRows).dueDate }
  };
  return plan;
};

module.exports = { addMonths, validatePlan, buildSchedule, planPayment, reshape, fillRows };
