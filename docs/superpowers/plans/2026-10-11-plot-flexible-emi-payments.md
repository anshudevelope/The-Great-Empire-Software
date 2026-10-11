# Flexible EMI Payments & Booking Statement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin record any amount on a plot booking — short payments, pay-ahead, and prepayments that reduce the EMI or the tenure — and download a full booking statement.

**Architecture:** Payments become `PlotReceipt` documents that allocate money across the instalment schedule (`PlotPayment` rows). A pure planner in `scheduleService` decides where money goes and how a prepayment reshapes the schedule; `receiptService` writes the plan in one transaction; commission is settled per receipt after commit, exactly as it is per payment today. Existing paid instalments are migrated to receipts with the same `_id`, so the commission ledger needs no change.

**Tech Stack:** Node + Express 5 + Mongoose 9 (backend `F:\Freelancing\Real Estate\The-Great-Empire-Software`), React + TypeScript + TanStack Query + Tailwind (frontend `F:\Freelancing\Real Estate\great-empire`).

**Spec:** `docs/superpowers/specs/2026-10-11-plot-flexible-emi-payments-design.md`

## Global Constraints

- **No test files** in either repo (project preference). Verify with scripts, `node -e`, lint/build and the browser. Throwaway harnesses live in the session scratchpad, never in the repo.
- **No git commits** (project preference). Skip every commit step.
- All T2 code runs inside `runInBusiness(BUSINESSES.T2, …)`; plot models are `bindModel(..., { only: BUSINESSES.T2 })`.
- Money is rounded with `round2`; the planner works in integer paise internally.
- EMIs are interest-free. Already-paid instalments are never changed (a part-paid future EMI is closed at what was paid).
- Commission rates and behaviour unchanged: 5% direct + 5% matching on `commissionBase = amount × rating%`, settled after commit, idempotent.
- Receipt numbers keep the `RCP-YYYY-NNNNNN` yearly counter.
- Frontend drill-in pages get a back arrow beside the title (`PageHeader back`).
- Backend commands run from `F:\Freelancing\Real Estate\The-Great-Empire-Software`; frontend commands from `F:\Freelancing\Real Estate\great-empire`.

## Review Focus

1. **Amount over the balance or ≤ 0** — must be refused with a clear 400, never create a receipt. (Task 6 scenario S7.)
2. **Extra money with no choice made** — recording must refuse; the preview must instead return `needsChoice: true`. (Tasks 2, 6.)
3. **Reshape after an earlier pay-ahead left a future EMI part-paid** — the paid part is kept, only the unpaid balance is reshaped, schedule still sums to the price. (Task 6 scenario S4.)
4. **Cancelling a booking after a prepayment** — all commission from every receipt reversed, partial rows cancelled, refund cap = total paid. (Task 6 scenario S6.)
5. **Double click / transaction retry** — receipt number minted inside the transaction, so a retried transaction never leaves two receipts. (Task 3 design; checked by `verify:plots` paidTotal = Σ receipts.)

---

## File map

Backend:
- Modify `config/plotConfig.js` — new statuses, adjustments, prepayment kind.
- Create `models/plots/Receipt.js` — `PlotReceipt`.
- Modify `models/plots/Payment.js` — pure schedule row.
- Modify `models/plots/Booking.js` — `revision`.
- Modify `models/plots/Commission.js` — `payment` refs `PlotReceipt`.
- Modify `services/plots/scheduleService.js` — `planPayment`, `reshape`, `fillRows`.
- Create `services/plots/receiptService.js` — `previewPayment`, `recordPayment`.
- Modify `services/plots/commissionService.js` — read receipts.
- Modify `controllers/plots/salesController.js`, `routes/plots/index.js`.
- Create `scripts/migratePlotReceipts.js`, `scripts/verifyPlotSchedules.js`.
- Modify `scripts/reconcilePlotCommissions.js`, `scripts/assignPlotBookingLeg.js`, `scripts/dev-seed/seedPlotDemo.js`, `package.json`.

Frontend:
- Modify `src/api/plots.ts`, `src/features/plots/format.ts`.
- Rewrite `src/features/plots/sales/BookingDetailPage.tsx`.
- Create `src/features/plots/sales/StatementPage.tsx`; route in `src/router.tsx`.
- Modify `ReceiptPage.tsx`, `PaymentsPage.tsx`, `DuesPage.tsx`.

---

### Task 1: Config and models

**Files:**
- Modify: `config/plotConfig.js`
- Create: `models/plots/Receipt.js`
- Modify: `models/plots/Payment.js`, `models/plots/Booking.js`, `models/plots/Commission.js`

**Interfaces:**
- Produces: `INSTALMENT_STATUSES.{DUE,PARTIAL,PAID,SUPERSEDED,CANCELLED}`, `OPEN_INSTALMENT_STATUSES`, `PAYMENT_ADJUSTMENTS.{REDUCE_EMI,REDUCE_TENURE,PAY_AHEAD}`, `PREPAYMENT` (= `'prepayment'`), model `PlotReceipt`, `PlotPayment.revision/paidAmount/lastPaidOn`, `PlotBooking.revision`.

- [ ] **Step 1: plotConfig** — replace the `INSTALMENT_STATUSES` line and add the new constants after it:

```js
const INSTALMENT_STATUSES = {
  DUE: 'due',
  PARTIAL: 'partial',
  PAID: 'paid',
  // Replaced when a prepayment reshaped the schedule; kept for history.
  SUPERSEDED: 'superseded',
  CANCELLED: 'cancelled'
};

// Instalments that still owe money.
const OPEN_INSTALMENT_STATUSES = [INSTALMENT_STATUSES.DUE, INSTALMENT_STATUSES.PARTIAL];

// What the admin does with money beyond what is due now, chosen per payment.
const PAYMENT_ADJUSTMENTS = { REDUCE_EMI: 'reduce_emi', REDUCE_TENURE: 'reduce_tenure', PAY_AHEAD: 'pay_ahead' };

// Receipt allocation kind for a principal prepayment that reshaped the schedule.
const PREPAYMENT = 'prepayment';
```

In `publicPlotConfig` add `adjustments: Object.values(PAYMENT_ADJUSTMENTS),` after `payment: PLOT_PAYMENT,`. Add `OPEN_INSTALMENT_STATUSES, PAYMENT_ADJUSTMENTS, PREPAYMENT,` to `module.exports` after `INSTALMENT_STATUSES,`.

- [ ] **Step 2: Create `models/plots/Receipt.js`**

```js
const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { INSTALMENT_KINDS, PAYMENT_ADJUSTMENTS, PREPAYMENT } = require('../../config/plotConfig');
const { PAYMENT_MODES } = require('../../config/constants');
const { round2 } = require('./shared');

/**
 * One payment the admin recorded on a booking — and its printed receipt.
 *
 * The money is spread over the schedule as `allocations`: what is due first,
 * oldest first, then any extra the way the admin chose. A prepayment that
 * reshaped the schedule is a `prepayment` allocation with no instalment, and
 * `adjustment` keeps the schedule before and after so the receipt explains
 * itself later. Commission is settled per receipt (plots/commissionService).
 */
const allocationSchema = new mongoose.Schema(
  {
    instalment: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotPayment', default: null },
    seq: { type: Number, default: null },
    kind: { type: String, enum: [...Object.values(INSTALMENT_KINDS), PREPAYMENT], required: true },
    amount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const snapshotSchema = new mongoose.Schema(
  {
    count: { type: Number, required: true },
    emi: { type: Number, required: true },
    endDate: { type: Date, required: true }
  },
  { _id: false }
);

const adjustmentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: Object.values(PAYMENT_ADJUSTMENTS), required: true },
    extra: { type: Number, required: true, min: 0 },
    before: { type: snapshotSchema, default: null },
    after: { type: snapshotSchema, default: null }
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotBooking', required: true, index: true },
    plot: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyPlot', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotClient', required: true },
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    amount: { type: Number, required: true, min: 0.01 },
    paidOn: { type: Date, required: true, index: true },
    mode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
    // Share of the payment that earns commission (T1-style rating).
    ratingPct: { type: Number, default: 100, min: 0, max: 100 },
    commissionBase: { type: Number, default: 0, min: 0 },
    receiptNo: { type: String, required: true, unique: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', default: null },
    receivedByCode: { type: String, default: null },

    allocations: { type: [allocationSchema], default: [] },
    adjustment: { type: adjustmentSchema, default: null },
    // Booking balance right after this receipt.
    balanceAfter: { type: Number, required: true, min: 0 }
  },
  { timestamps: true }
);

// Derived here rather than by callers, so nothing can leave it out of step.
receiptSchema.pre('validate', function setCommissionBase() {
  this.commissionBase = round2((this.amount || 0) * ((this.ratingPct ?? 100) / 100));
});

module.exports = bindModel('PlotReceipt', receiptSchema, { only: BUSINESSES.T2 });
```

- [ ] **Step 3: Rewrite `models/plots/Payment.js`**

```js
const mongoose = require('mongoose');
const { bindModel } = require('../../utils/businessContext');
const { BUSINESSES } = require('../../config/business');
const { INSTALMENT_KINDS, INSTALMENT_STATUSES } = require('../../config/plotConfig');

/**
 * One instalment of a booking's schedule — what is owed and how much of it
 * has been paid. The money itself lives on PlotReceipt (one per payment),
 * whose allocations add up here.
 *
 * seq 0 is the full (one-time) or down payment; EMIs run 1…N. A prepayment
 * that reduces the EMI or the tenure marks the unpaid future rows
 * `superseded` and adds replacements with the next `revision`.
 */
const paymentSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotBooking', required: true },
    plot: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyPlot', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'PropertyProject', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotClient', required: true },
    associate: { type: mongoose.Schema.Types.ObjectId, ref: 'Associate', required: true },

    kind: { type: String, enum: Object.values(INSTALMENT_KINDS), required: true },
    seq: { type: Number, required: true, min: 0 },
    revision: { type: Number, default: 0, min: 0 },
    dueDate: { type: Date, required: true, index: true },
    dueAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(INSTALMENT_STATUSES), default: INSTALMENT_STATUSES.DUE, index: true },

    // Builds up across receipts.
    paidAmount: { type: Number, default: 0, min: 0 },
    lastPaidOn: { type: Date, default: null }
  },
  { timestamps: true }
);

paymentSchema.index({ booking: 1, seq: 1, revision: 1 }, { unique: true });

module.exports = bindModel('PlotPayment', paymentSchema, { only: BUSINESSES.T2 });
```

- [ ] **Step 4: Booking** — in `models/plots/Booking.js` replace the two lines `tenureMonths: …` and `emiAmount: …` with:

```js
    // The live schedule: updated when a prepayment reshapes it.
    tenureMonths: { type: Number, default: 0, min: 0 },
    emiAmount: { type: Number, default: 0, min: 0 },
    revision: { type: Number, default: 0, min: 0 },
```

- [ ] **Step 5: Commission** — in `models/plots/Commission.js` change the `payment` line to:

```js
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'PlotReceipt', default: null },
```

and the comment above `sourceAssociate` to `// What produced it: the associate the sale is credited to, and the receipt.`

- [ ] **Step 6: Verify the models load**

Run: `node -e "require('./models/plots/Receipt');require('./models/plots/Payment');require('./models/plots/Booking');require('./models/plots/Commission');const c=require('./config/plotConfig');console.log(c.OPEN_INSTALMENT_STATUSES,c.PAYMENT_ADJUSTMENTS,c.PREPAYMENT)"`
Expected: `[ 'due', 'partial' ] { REDUCE_EMI: 'reduce_emi', REDUCE_TENURE: 'reduce_tenure', PAY_AHEAD: 'pay_ahead' } prepayment`

---

### Task 2: Payment planner (pure)

**Files:**
- Modify: `services/plots/scheduleService.js`

**Interfaces:**
- Consumes: Task 1 constants.
- Produces: `planPayment({ booking: { price, paidTotal, emiAmount }, rows, amount, paidOn, adjustment? }) → plan` where `plan = { balance, dueNow, extra, fills: [{ row, amount }], needsChoice, adjustment, prepayment, close, supersede, newRows: [{ kind, seq, dueDate, dueAmount }], balanceAfter, completes }`. `rows` are open instalments sorted by `seq` with `{ _id, seq, kind, dueDate, dueAmount, paidAmount }` (plain objects or Mongoose docs — `fills[].row`, `close` and `supersede` are the same objects passed in). Throws `httpError(…, 400)` on bad input.

- [ ] **Step 1: Add to `scheduleService.js`** — change the first import line to

```js
const { PAYMENT_PLANS, PLOT_PAYMENT, INSTALMENT_KINDS, PAYMENT_ADJUSTMENTS } = require('../../config/plotConfig');
```

and insert before `module.exports`:

```js
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
  if (paise > balance) throw httpError(`Amount cannot be more than the balance of ₹${fromPaise(balance)}.`);
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
    close: null,
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
  // A future EMI part-paid by an earlier pay-ahead keeps what was paid and is
  // closed at that; only the unpaid EMIs are reshaped.
  const partial = future.find((r) => toPaise(r.paidAmount) > 0) || null;
  const slots = future.filter((r) => r !== partial);
  if (!slots.length) throw httpError('No upcoming EMIs are left to reshape — choose "Pay upcoming EMIs" instead.');

  const newRows = reshape({ slots, balance: futureOwed - first.left, mode: adjustment, emiAmount: booking.emiAmount });
  plan.prepayment = plan.extra;
  plan.close = partial;
  plan.supersede = slots;
  plan.newRows = newRows;
  plan.adjustment = {
    type: adjustment,
    extra: plan.extra,
    before: { count: future.length, emi: booking.emiAmount, endDate: lastOf(future).dueDate },
    after: { count: newRows.length, emi: newRows[0].dueAmount, endDate: lastOf(newRows).dueDate }
  };
  return plan;
};
```

Update the export line to:

```js
module.exports = { addMonths, validatePlan, buildSchedule, planPayment, reshape, fillRows };
```

- [ ] **Step 2: Write a scratch check** at `<scratchpad>/checkPlan.js` (session scratchpad, not the repo):

```js
const path = require('path');
const { planPayment, buildSchedule } = require(path.join(process.argv[2], 'services/plots/scheduleService'));

const sum = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
const rowsOf = (sched) => sched.rows.map((r, i) => ({ ...r, _id: i, paidAmount: 0 }));
const booking = { price: 912000, paidTotal: 12000, emiAmount: 75000 };
// 12 EMIs of 75,000 from Jan 2026; down 12,000 already paid.
const sched = buildSchedule({ plan: 'emi', price: 912000, downPayment: 12000, tenureMonths: 12, bookedOn: new Date(2025, 11, 10) });
const rows = rowsOf(sched).filter((r) => r.kind === 'emi');
const check = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

// Short pay before anything is due → extra needs a choice.
let p = planPayment({ booking, rows, amount: 30000, paidOn: new Date(2025, 11, 20) });
check('nothing due yet → needsChoice', p.needsChoice && p.fills.length === 0);

// Short pay on a due EMI → partial fill, no choice needed.
p = planPayment({ booking, rows, amount: 30000, paidOn: new Date(2026, 0, 10) });
check('short pay fills 30,000 of EMI 1', p.fills.length === 1 && p.fills[0].amount === 30000 && !p.needsChoice);

// 3,75,000 on EMI 1's date with reduce_emi → 11 smaller EMIs; schedule still sums to balance.
p = planPayment({ booking, rows, amount: 375000, paidOn: new Date(2026, 0, 10), adjustment: 'reduce_emi' });
check('reduce_emi keeps 11 slots', p.newRows.length === 11);
check('reduce_emi sums to balance', sum(p.newRows.map((r) => r.dueAmount)) + 375000 === 900000);

// Same with reduce_tenure → EMI stays 75,000, fewer rows.
p = planPayment({ booking, rows, amount: 375000, paidOn: new Date(2026, 0, 10), adjustment: 'reduce_tenure' });
check('reduce_tenure keeps 75,000 EMIs', p.newRows[0].dueAmount === 75000 && p.newRows.length === 7);
check('reduce_tenure sums to balance', sum(p.newRows.map((r) => r.dueAmount)) + 375000 === 900000);

// Pay ahead 2 EMIs and a bit.
p = planPayment({ booking, rows, amount: 160000, paidOn: new Date(2026, 0, 10), adjustment: 'pay_ahead' });
check('pay_ahead fills 3 rows, last partial 10,000', p.fills.length === 3 && p.fills[2].amount === 10000);

// Reshape with a part-paid future EMI keeps its paid part.
const withPartial = rows.map((r, i) => (i === 1 ? { ...r, paidAmount: 10000 } : r));
p = planPayment({ booking: { ...booking, paidTotal: 22000 }, rows: withPartial, amount: 200000, paidOn: new Date(2026, 0, 10), adjustment: 'reduce_emi' });
check('partial future row is closed', p.close && p.close.seq === 2 && !p.supersede.includes(p.close));
check('reshape over partial sums to balance', sum(p.newRows.map((r) => r.dueAmount)) + 75000 + 10000 + (200000 - 75000) === 900000);

// Full balance → completes, no choice.
p = planPayment({ booking, rows, amount: 900000, paidOn: new Date(2026, 0, 10) });
check('full balance completes', p.completes && !p.needsChoice && sum(p.fills.map((f) => f.amount)) === 900000);

// Errors.
const throws = (fn) => { try { fn(); return false; } catch (e) { return e.status === 400; } };
check('over balance → 400', throws(() => planPayment({ booking, rows, amount: 900001, paidOn: new Date() })));
check('zero → 400', throws(() => planPayment({ booking, rows, amount: 0, paidOn: new Date() })));
check('bad adjustment → 400', throws(() => planPayment({ booking, rows, amount: 100000, paidOn: new Date(2026, 0, 10), adjustment: 'nope' })));
```

- [ ] **Step 3: Run it**

Run: `node <scratchpad>/checkPlan.js "F:\Freelancing\Real Estate\The-Great-Empire-Software"`
Expected: every line starts with `PASS`. Fix `planPayment` until they do.

---

### Task 3: Receipt service

**Files:**
- Create: `services/plots/receiptService.js`

**Interfaces:**
- Consumes: `planPayment` (Task 2), `PlotReceipt`/`PlotPayment`/`PlotBooking` (Task 1), `nextReceiptNo(session, date)` and `round2`, `httpError` from `services/plots/helpers`.
- Produces:
  - `previewPayment({ bookingId, amount, paidOn, adjustment }) → { balance, dueNow, extra, needsChoice, completes, balanceAfter, adjustment, allocations, newSchedule }`
  - `recordPayment({ bookingId, amount, paidOn, mode, reference, notes, ratingPct, adjustment, actor }, session) → PlotReceipt document` — must be called inside `withTransaction`; does NOT settle commission.

- [ ] **Step 1: Create the file**

```js
const PlotBooking = require('../../models/plots/Booking');
const PlotPayment = require('../../models/plots/Payment');
const PlotReceipt = require('../../models/plots/Receipt');
const { BOOKING_STATUSES, INSTALMENT_STATUSES, OPEN_INSTALMENT_STATUSES, PREPAYMENT } = require('../../config/plotConfig');
const { planPayment } = require('./scheduleService');
const { round2, httpError, nextReceiptNo } = require('./helpers');

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

const openRows = (bookingId, session = null) =>
  PlotPayment.find({ booking: bookingId, status: { $in: OPEN_INSTALMENT_STATUSES } }).sort({ seq: 1 }).session(session);

const loadActive = async (bookingId, session = null) => {
  const booking = await PlotBooking.findById(bookingId).session(session);
  if (!booking) throw httpError('Booking not found.', 404);
  if (booking.status !== BOOKING_STATUSES.ACTIVE) throw httpError('This booking is not active.', 409);
  return booking;
};

// Where the money went, as stored on the receipt.
const allocationsOf = (plan) => [
  ...plan.fills.map(({ row, amount }) => ({ instalment: row._id, seq: row.seq, kind: row.kind, amount })),
  ...(plan.prepayment > 0 ? [{ instalment: null, seq: null, kind: PREPAYMENT, amount: plan.prepayment }] : [])
];

/** What a payment would do, without writing anything — for the form's preview. */
const previewPayment = async ({ bookingId, amount, paidOn, adjustment = null }) => {
  const booking = await loadActive(bookingId);
  const plan = planPayment({ booking, rows: await openRows(booking._id).lean(), amount, paidOn, adjustment });
  return {
    balance: plan.balance,
    dueNow: plan.dueNow,
    extra: plan.extra,
    needsChoice: plan.needsChoice,
    completes: plan.completes,
    balanceAfter: plan.balanceAfter,
    adjustment: plan.adjustment,
    allocations: allocationsOf(plan),
    newSchedule: plan.newRows
  };
};

/**
 * Record one payment inside the caller's transaction: fill the instalments it
 * pays, reshape the schedule when the admin chose to, move the booking's
 * totals and issue the receipt. The receipt number is minted inside the
 * transaction, so a retried attempt never leaves a second receipt behind.
 *
 * Commission is NOT run here — the caller settles the receipt after commit.
 */
const recordPayment = async (
  { bookingId, amount, paidOn, mode = null, reference = '', notes = '', ratingPct = 100, adjustment = null, actor = null },
  session
) => {
  const booking = await loadActive(bookingId, session);
  const plan = planPayment({ booking, rows: await openRows(booking._id, session), amount, paidOn, adjustment });
  if (plan.needsChoice) {
    throw httpError(`Choose how to apply the extra ${inr(plan.extra)}: reduce EMI, reduce tenure or pay upcoming EMIs.`);
  }

  for (const { row, amount: part } of plan.fills) {
    row.paidAmount = round2(row.paidAmount + part);
    row.status = row.paidAmount >= row.dueAmount ? INSTALMENT_STATUSES.PAID : INSTALMENT_STATUSES.PARTIAL;
    row.lastPaidOn = paidOn;
    await row.save({ session });
  }

  if (plan.close) {
    plan.close.dueAmount = plan.close.paidAmount;
    plan.close.status = INSTALMENT_STATUSES.PAID;
    await plan.close.save({ session });
  }

  if (plan.newRows.length) {
    await PlotPayment.updateMany(
      { _id: { $in: plan.supersede.map((r) => r._id) } },
      { $set: { status: INSTALMENT_STATUSES.SUPERSEDED } },
      { session }
    );
    booking.revision += 1;
    await PlotPayment.create(
      plan.newRows.map((r) => ({
        ...r,
        revision: booking.revision,
        booking: booking._id,
        plot: booking.plot,
        project: booking.project,
        client: booking.client,
        associate: booking.associate
      })),
      { session, ordered: true }
    );
    booking.emiAmount = plan.adjustment.after.emi;
    booking.tenureMonths = plan.newRows[plan.newRows.length - 1].seq;
  }

  booking.paidTotal = round2(booking.paidTotal + round2(amount));
  if (plan.completes) booking.status = BOOKING_STATUSES.COMPLETED;
  await booking.save({ session });

  const [receipt] = await PlotReceipt.create(
    [
      {
        booking: booking._id,
        plot: booking.plot,
        project: booking.project,
        client: booking.client,
        associate: booking.associate,
        amount: round2(amount),
        paidOn,
        mode: mode || null,
        reference,
        notes,
        ratingPct,
        receiptNo: await nextReceiptNo(session, paidOn),
        receivedBy: actor?._id ?? null,
        receivedByCode: actor?.memberCode ?? null,
        allocations: allocationsOf(plan),
        adjustment: plan.adjustment,
        balanceAfter: plan.balanceAfter
      }
    ],
    { session }
  );
  return receipt;
};

module.exports = { previewPayment, recordPayment };
```

- [ ] **Step 2: Verify it loads**

Run: `node -e "const s=require('./services/plots/receiptService');console.log(typeof s.previewPayment, typeof s.recordPayment)"`
Expected: `function function`

---

### Task 4: Commission reads receipts

**Files:**
- Modify: `services/plots/commissionService.js`, `scripts/reconcilePlotCommissions.js`, `scripts/assignPlotBookingLeg.js`

**Interfaces:**
- Produces (names unchanged, argument is now a receipt id): `onPaymentReceived(receiptId)`, `settlePayment(receiptId)`, `postOwnLegForPayment(receiptId)`, `reverseBooking(bookingId, reason)`.

- [ ] **Step 1: commissionService** — make these exact edits:
  - Replace `const PlotPayment = require('../../models/plots/Payment');` with `const PlotReceipt = require('../../models/plots/Receipt');`.
  - Replace `const { PLOT_COMMISSION, PLOT_SELF_LEG, INSTALMENT_STATUSES, BOOKING_STATUSES } = require('../../config/plotConfig');` with `const { PLOT_COMMISSION, PLOT_SELF_LEG, BOOKING_STATUSES } = require('../../config/plotConfig');`.
  - In the header comment change `Runs AFTER a payment's transaction commits` to `Runs AFTER a receipt's transaction commits`, and `(scripts/reconcilePlotCommissions.js)` stays.
  - In `payMatching`, change `const businessVolume = payment.paidAmount;` to `const businessVolume = payment.amount;`.
  - Replace the first lines of `onPaymentReceived`:

```js
const onPaymentReceived = async (receiptId) => {
  const payment = await PlotReceipt.findById(receiptId).lean();
  if (!payment) return { skipped: 'receipt not found' };
```

    (delete the old `PlotPayment.findById` line and its `status !== PAID` check), and update its doc comment's first line to `Entry point after a receipt is recorded. Idempotent.`
  - Replace the first lines of `postOwnLegForPayment` the same way:

```js
const postOwnLegForPayment = async (receiptId) => {
  const payment = await PlotReceipt.findById(receiptId).lean();
  if (!payment) return { skipped: 'receipt not found' };
```

  - In `reverseBooking` replace

```js
    const payments = await PlotPayment.find({ _id: { $in: posted.map((p) => p.payment) } })
      .select('paidAmount commissionBase')
      .lean();
    const rated = round2(payments.reduce((s, p) => s + (p.commissionBase || 0), 0));
    const whole = round2(payments.reduce((s, p) => s + (p.paidAmount || 0), 0));
```

    with

```js
    const receipts = await PlotReceipt.find({ _id: { $in: posted.map((p) => p.payment) } })
      .select('amount commissionBase')
      .lean();
    const rated = round2(receipts.reduce((s, r) => s + (r.commissionBase || 0), 0));
    const whole = round2(receipts.reduce((s, r) => s + (r.amount || 0), 0));
```

  - In the `settlePayment` doc comment write `/** onPaymentReceived that never throws — the receipt has already committed. */`; change its log text `payment ${paymentId}` to `receipt ${paymentId}`.

- [ ] **Step 2: reconcilePlotCommissions.js** — replace `const PlotPayment = require('../models/plots/Payment');` with `const PlotReceipt = require('../models/plots/Receipt');`, change `const { INSTALMENT_STATUSES, BOOKING_STATUSES } = …` to `const { BOOKING_STATUSES } = …`, and replace the "Paid instalments" block with:

```js
    // Receipts whose volume was never posted.
    const posted = new Set(
      (await PlotCommission.find({ idempotencyKey: /^plot:volume:/ }).select('payment').lean()).map((r) => String(r.payment))
    );
    const receipts = await PlotReceipt.find().select('_id receiptNo').sort({ paidOn: 1 }).lean();
    const missing = receipts.filter((r) => !posted.has(String(r._id)));
    console.log(`Receipts: ${receipts.length}, without commission: ${missing.length}`);
    for (const r of missing) {
      const result = await onPaymentReceived(r._id);
      console.log(`  ${r.receiptNo}: ${result.skipped ? `skipped (${result.skipped})` : 'settled'}`);
    }
```

  Also change the file's doc comment `for every paid instalment` → `for every receipt`.

- [ ] **Step 3: assignPlotBookingLeg.js** — replace `const PlotPayment = require('../models/plots/Payment');` with `const PlotReceipt = require('../models/plots/Receipt');`, change the config import to `const { BOOKING_STATUSES } = require('../config/plotConfig');`, and replace the loop with:

```js
    const receipts = await PlotReceipt.find({ booking: booking._id }).sort({ paidOn: 1, createdAt: 1 }).lean();
    for (const r of receipts) {
      const result = await postOwnLegForPayment(r._id);
      const matched = (result.matching || []).reduce((sum, row) => sum + row.amount, 0);
      console.log(
        `  ${r.receiptNo} ₹${r.amount} (${r.ratingPct}%): ${result.skipped ? `skipped — ${result.skipped}` : `moved${matched ? `, matching ₹${matched}` : ''}`}`
      );
    }
```

- [ ] **Step 4: Verify they load**

Run: `node -e "require('./services/plots/commissionService');console.log('ok')"`
Expected: `ok`

---

### Task 5: Migration of existing paid instalments

**Files:**
- Create: `scripts/migratePlotReceipts.js`
- Modify: `package.json` (add `"migrate:plot-receipts": "node scripts/migratePlotReceipts.js",` after the `"migrate"` script)

**Interfaces:**
- Consumes: Task 1 models.
- Produces: every paid instalment has a `PlotReceipt` with the same `_id`; instalments lose the moved fields; indexes rebuilt.

- [ ] **Step 1: Create the script**

```js
/**
 * One-time: split paid plot instalments into PlotReceipt records.
 *
 *   npm run migrate:plot-receipts            dry run — counts only
 *   npm run migrate:plot-receipts -- --apply
 *
 * Each paid instalment becomes one receipt with the SAME _id, so every plot
 * commission row and idempotency key (plot:direct:<id>, plot:volume:<id>)
 * already points at its receipt. Then the receipt fields come off the
 * instalments and the indexes are rebuilt. Safe to run again.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BUSINESSES } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');
const PlotPayment = require('../models/plots/Payment');
const PlotReceipt = require('../models/plots/Receipt');
const PlotBooking = require('../models/plots/Booking');
const { round2 } = require('../services/plots/helpers');

const apply = process.argv.includes('--apply');
const MOVED = ['paidOn', 'mode', 'reference', 'notes', 'ratingPct', 'commissionBase', 'receiptNo', 'receivedBy', 'receivedByCode'];

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  await runInBusiness(BUSINESSES.T2, async () => {
    console.log(`Connected to "${mongoose.connection.name}_t2"${apply ? '  [--apply]' : '  [DRY RUN]'}\n`);

    // Raw reads: the moved fields are no longer in the schema.
    const paid = await PlotPayment.collection
      .find({ receiptNo: { $type: 'string' } })
      .sort({ booking: 1, paidOn: 1, seq: 1 })
      .toArray();
    const existing = new Set((await PlotReceipt.find({ _id: { $in: paid.map((p) => p._id) } }).distinct('_id')).map(String));
    const prices = new Map(
      (await PlotBooking.find({ _id: { $in: [...new Set(paid.map((p) => String(p.booking)))] } }).select('price').lean()).map((b) => [
        String(b._id),
        b.price
      ])
    );
    console.log(`Paid instalments: ${paid.length}, already receipts: ${existing.size}, to migrate: ${paid.length - existing.size}`);

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply.');
      return;
    }

    // Running total per booking in payment order, for balanceAfter.
    const paidSoFar = new Map();
    const docs = [];
    for (const p of paid) {
      const key = String(p.booking);
      const total = round2((paidSoFar.get(key) || 0) + p.paidAmount);
      paidSoFar.set(key, total);
      if (existing.has(String(p._id))) continue;
      docs.push({
        _id: p._id,
        booking: p.booking,
        plot: p.plot,
        project: p.project,
        client: p.client,
        associate: p.associate,
        amount: p.paidAmount,
        paidOn: p.paidOn,
        mode: p.mode ?? null,
        reference: p.reference || '',
        notes: p.notes || '',
        ratingPct: p.ratingPct ?? 100,
        commissionBase: p.commissionBase ?? round2(p.paidAmount * ((p.ratingPct ?? 100) / 100)),
        receiptNo: p.receiptNo,
        receivedBy: p.receivedBy ?? null,
        receivedByCode: p.receivedByCode ?? null,
        allocations: [{ instalment: p._id, seq: p.seq, kind: p.kind, amount: p.paidAmount }],
        adjustment: null,
        balanceAfter: round2(prices.get(key) - total),
        createdAt: p.updatedAt,
        updatedAt: p.updatedAt
      });
    }
    // Raw insert keeps the original timestamps.
    if (docs.length) await PlotReceipt.collection.insertMany(docs);

    await PlotPayment.collection.updateMany({ receiptNo: { $type: 'string' } }, [{ $set: { lastPaidOn: '$paidOn' } }]);
    await PlotPayment.collection.updateMany({}, { $unset: Object.fromEntries(MOVED.map((f) => [f, ''])) });
    await PlotPayment.collection.updateMany({ revision: { $exists: false } }, { $set: { revision: 0 } });
    await PlotPayment.collection.updateMany({ lastPaidOn: { $exists: false } }, { $set: { lastPaidOn: null } });
    await PlotBooking.collection.updateMany({ revision: { $exists: false } }, { $set: { revision: 0 } });

    // Drops booking_1_seq_1 and the old receiptNo index, builds the new ones.
    await PlotPayment.syncIndexes();
    await PlotReceipt.syncIndexes();

    console.log(`Created ${docs.length} receipt(s); instalments cleaned; indexes rebuilt.`);
  });

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Migration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 2: Snapshot before** — record totals to compare after:

Run: `node -e "require('dotenv').config({quiet:true});const m=require('mongoose');(async()=>{await m.connect(process.env.MONGO_URI);const db=m.connection.client.db(m.connection.name+'_t2');const paid=await db.collection('plotpayments').aggregate([{\$match:{receiptNo:{\$type:'string'}}},{\$group:{_id:null,n:{\$sum:1},amt:{\$sum:'\$paidAmount'}}}]).toArray();console.log(paid);await m.disconnect()})()"`
Expected: `[ { _id: null, n: 14, amt: <total> } ]` — note the numbers.

- [ ] **Step 3: Dry run, then apply**

Run: `npm run migrate:plot-receipts` → Expected: `Paid instalments: 14, already receipts: 0, to migrate: 14`
Run: `npm run migrate:plot-receipts -- --apply` → Expected: `Created 14 receipt(s); instalments cleaned; indexes rebuilt.`
Run again: `npm run migrate:plot-receipts -- --apply` → Expected: `to migrate: 0`, `Created 0 receipt(s)`.

- [ ] **Step 4: Check after**

Run: `node -e "require('dotenv').config({quiet:true});const m=require('mongoose');(async()=>{await m.connect(process.env.MONGO_URI);const db=m.connection.client.db(m.connection.name+'_t2');console.log(await db.collection('plotreceipts').aggregate([{\$group:{_id:null,n:{\$sum:1},amt:{\$sum:'\$amount'}}}]).toArray());console.log(await db.collection('plotpayments').countDocuments({receiptNo:{\$exists:true}}));console.log((await db.collection('plotpayments').indexes()).map(i=>i.name));await m.disconnect()})()"`
Expected: same `n` and `amt` as Step 2; `0`; index list contains `booking_1_seq_1_revision_1` and not `booking_1_seq_1` or `receiptNo_1`.

---

### Task 6: Sales controller, routes and backend scenarios

**Files:**
- Modify: `controllers/plots/salesController.js`, `routes/plots/index.js`

**Interfaces:**
- Consumes: `receiptService.recordPayment/previewPayment` (Task 3), `settlePayment` (Task 4).
- Produces endpoints: `GET /plot-sales/bookings/:id/payment-preview?amount&paidOn&adjustment`, `POST /plot-sales/bookings/:id/payments`, `GET /plot-sales/bookings/:id/statement`; changed `GET /bookings/:id`, `GET /payments`, `GET /payments/dues`, `GET /payments/:id/receipt`, `POST /bookings`. Response shapes are exactly those typed in Task 9.

- [ ] **Step 1: Imports** — at the top of `salesController.js`:
  - add `const PlotReceipt = require('../../models/plots/Receipt');` after the `PlotPayment` require;
  - add `const receiptService = require('../../services/plots/receiptService');` after the `scheduleService` require;
  - change the plotConfig import to:

```js
const {
  RECORD_STATUSES,
  PLOT_STATUSES,
  BOOKING_STATUSES,
  INSTALMENT_STATUSES,
  INSTALMENT_KINDS,
  OPEN_INSTALMENT_STATUSES,
  PAYMENT_ADJUSTMENTS,
  PAYMENT_PLANS,
  PLOT_RATING,
  PLOT_SELF_LEG,
  PREPAYMENT
} = require('../../config/plotConfig');
```

  - remove `nextReceiptNo,` from the helpers import.

- [ ] **Step 2: createBooking** — replace everything from `let firstPaidId = null;` through `return { booking: created, paidId: firstPaidId };` with:

```js
      // create() rather than insertMany so validation runs.
      await PlotPayment.create(docs, { session, ordered: true });

      // Collecting the first instalment on the spot is an ordinary payment of
      // its amount. pay_ahead covers a plan with no down payment, where the
      // first EMI falls a month after booking.
      const receipt = payNow
        ? await receiptService.recordPayment(
            {
              bookingId: created._id,
              amount: docs[0].dueAmount,
              paidOn: payNow.paidOn ? new Date(payNow.paidOn) : bookedOn,
              mode: payNow.mode || null,
              reference: str(payNow.reference),
              ratingPct: rating,
              adjustment: PAYMENT_ADJUSTMENTS.PAY_AHEAD,
              actor: req.user
            },
            session
          )
        : null;
      return { booking: created, paidId: receipt?._id ?? null };
```

  (the `docs` array and everything before it stay as they are). The `if (paidId) await settlePayment(paidId);` line after the transaction stays. In the response keep `receiptPaymentId: paidId`.

- [ ] **Step 3: Due state helper** — replace `withDueState` with:

```js
// Paid / due / overdue state for one instalment, as the UI shows it.
const withDueState = (p, today = startOfDay()) => ({
  ...p,
  remaining: round2(p.dueAmount - p.paidAmount),
  overdue: OPEN_INSTALMENT_STATUSES.includes(p.status) && new Date(p.dueDate) < today
});

const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
};
```

- [ ] **Step 4: getBooking** — replace its body after the `if (!booking)` line with:

```js
    const [schedule, receipts] = await Promise.all([
      PlotPayment.find({ booking: booking._id }).sort({ seq: 1, revision: 1 }).lean(),
      PlotReceipt.find({ booking: booking._id }).sort({ paidOn: 1, createdAt: 1 }).lean()
    ]);
    const today = startOfDay();
    const rows = schedule.map((p) => withDueState(p, today));
    const open = rows.filter((p) => OPEN_INSTALMENT_STATUSES.includes(p.status));
    const cutoff = endOfToday();
    res.status(200).json({
      success: true,
      data: {
        ...booking,
        schedule: rows,
        receipts,
        balance: round2(booking.price - booking.paidTotal),
        dueNow: round2(open.filter((p) => new Date(p.dueDate) <= cutoff).reduce((s, p) => s + p.remaining, 0)),
        nextDue: open[0] || null
      }
    });
```

- [ ] **Step 5: cancelBooking** — change `{ booking: current._id, status: INSTALMENT_STATUSES.DUE }` to `{ booking: current._id, status: { $in: OPEN_INSTALMENT_STATUSES } }`.

- [ ] **Step 6: Replace `exports.receivePayment` entirely** with:

```js
const paymentInput = (source) => {
  const amount = round2(numberOr(source.amount, NaN));
  if (Number.isNaN(amount)) throw httpError('Amount must be a number.');
  const paidOn = source.paidOn ? new Date(source.paidOn) : new Date();
  if (Number.isNaN(paidOn.getTime())) throw httpError('Invalid payment date.');
  const adjustment = source.adjustment || null;
  if (adjustment && !Object.values(PAYMENT_ADJUSTMENTS).includes(adjustment)) throw httpError('Unknown way to apply the extra amount.');
  return { amount, paidOn, adjustment };
};

// What the Receive form shows before saving. Same maths the payment will use.
exports.previewPayment = async (req, res, next) => {
  try {
    assertId(req.params.id, 'booking');
    const data = await receiptService.previewPayment({ bookingId: req.params.id, ...paymentInput(req.query) });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * Record a payment of any amount up to the balance: what is due is cleared
 * first, oldest first; any extra is applied the way the admin chose. One
 * transaction; commission on the receipt runs after commit.
 */
exports.recordPayment = async (req, res, next) => {
  try {
    assertId(req.params.id, 'booking');
    const input = paymentInput(req.body);
    if (req.body.mode && !PAYMENT_MODES.includes(req.body.mode)) throw httpError('Unknown payment mode.');
    const ratingPct = ratingOf(req.body.ratingPct);

    const receipt = await withTransaction((session) =>
      receiptService.recordPayment(
        {
          bookingId: req.params.id,
          ...input,
          mode: req.body.mode || null,
          reference: str(req.body.reference),
          notes: typeof req.body.notes === 'string' ? req.body.notes : '',
          ratingPct,
          actor: req.user
        },
        session
      )
    );

    await settlePayment(receipt._id);
    await record(req, {
      action: PLOT_ACTIONS.PAYMENT_RECEIVED,
      targetType: 'PlotReceipt',
      target: receipt._id,
      targetCode: receipt.receiptNo,
      after: { amount: receipt.amount, ratingPct: receipt.ratingPct, adjustment: receipt.adjustment?.type ?? null }
    });

    res.status(201).json({ success: true, message: `Payment received — receipt ${receipt.receiptNo}.`, data: receipt });
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 7: listPayments → receipts** — replace `paymentPopulate` and the whole `exports.listPayments` with:

```js
const salePopulate = (q) =>
  q
    .populate('booking', 'code plan status')
    .populate('plot', 'code name')
    .populate('project', 'code name')
    .populate('client', 'code fullName mobile')
    .populate('associate', 'memberCode fullName');

const KIND_TEXT = { full: 'Full payment', down: 'Down payment' };
const appliedTo = (r) =>
  r.allocations
    .map((a) => (a.kind === PREPAYMENT ? 'Prepayment' : a.kind === INSTALMENT_KINDS.EMI ? `EMI ${a.seq}` : KIND_TEXT[a.kind]))
    .join(', ');

// Payment history: one row per receipt; filters by date, kind, project.
exports.listPayments = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.kind) filter['allocations.kind'] = req.query.kind;
    if (req.query.project) {
      assertId(req.query.project, 'project');
      filter.project = oid(req.query.project);
    }
    if (req.query.booking) {
      assertId(req.query.booking, 'booking');
      filter.booking = oid(req.query.booking);
    }
    if (req.query.from || req.query.to) {
      filter.paidOn = {};
      if (req.query.from) filter.paidOn.$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter.paidOn.$lte = to;
      }
    }
    if (req.query.search) Object.assign(filter, searchFilter(req.query.search, ['receiptNo', 'reference']));

    if (req.query.format === 'csv') {
      const cursor = salePopulate(PlotReceipt.find(filter).sort({ paidOn: -1 })).lean().cursor();
      return streamCsv(
        res,
        `plot-payments-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          { header: 'Receipt No', value: (r) => r.receiptNo },
          { header: 'Paid On', value: (r) => r.paidOn },
          { header: 'Booking', value: (r) => r.booking?.code },
          { header: 'Project', value: (r) => r.project?.name },
          { header: 'Plot', value: (r) => r.plot?.name },
          { header: 'Client', value: (r) => r.client?.fullName },
          { header: 'Client Mobile', value: (r) => r.client?.mobile },
          { header: 'Associate', value: (r) => r.associate?.memberCode },
          { header: 'Applied To', value: appliedTo },
          { header: 'Adjustment', value: (r) => r.adjustment?.type || '' },
          { header: 'Amount', value: (r) => r.amount },
          { header: 'Rating %', value: (r) => r.ratingPct },
          { header: 'Mode', value: (r) => r.mode || '' },
          { header: 'Reference', value: (r) => r.reference || '' }
        ],
        cursor
      );
    }

    const { page, limit, skip } = pageOf(req.query);
    const [rows, total, sums] = await Promise.all([
      salePopulate(PlotReceipt.find(filter)).sort({ paidOn: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      PlotReceipt.countDocuments(filter),
      PlotReceipt.aggregate([{ $match: filter }, { $group: { _id: null, paid: { $sum: '$amount' } } }])
    ]);
    return listResponse(res, { rows, total, page, limit, extra: { summary: { paid: round2(sums[0]?.paid || 0) } } });
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 8: listDues** — in `exports.listDues`:
  - change `const filter = { status: INSTALMENT_STATUSES.DUE, dueDate: { $lte: asOf } };` to `const filter = { status: { $in: OPEN_INSTALMENT_STATUSES }, dueDate: { $lte: asOf } };`
  - replace `paymentPopulate(` with `salePopulate(`
  - replace the `$group` stage with:

```js
        {
          $group: {
            _id: null,
            due: { $sum: { $subtract: ['$dueAmount', '$paidAmount'] } },
            overdue: { $sum: { $cond: [{ $lt: ['$dueDate', startOfDay()] }, { $subtract: ['$dueAmount', '$paidAmount'] }, 0] } },
            overdueCount: { $sum: { $cond: [{ $lt: ['$dueDate', startOfDay()] }, 1, 0] } }
          }
        }
```

- [ ] **Step 9: getReceipt** — replace the whole function with:

```js
// One receipt, with everything its printed copy shows.
exports.getReceipt = async (req, res, next) => {
  try {
    assertId(req.params.id, 'receipt');
    const receipt = await PlotReceipt.findById(req.params.id)
      .populate({ path: 'booking', select: 'code plan price paidTotal tenureMonths emiAmount bookedOn status' })
      .populate({ path: 'plot', select: 'code name size facing block', populate: { path: 'block', select: 'name' } })
      .populate({ path: 'project', select: 'code name location company', populate: { path: 'company' } })
      .populate('client')
      .populate('associate', 'memberCode fullName')
      .lean();
    if (!receipt) throw httpError('Receipt not found.', 404);
    res.status(200).json({ success: true, data: { ...receipt, balance: receipt.balanceAfter } });
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 10: Statement** — add at the end of the file:

```js
/**
 * Everything the printed booking statement shows: the sale, the live
 * schedule (replaced rows left out), every receipt, and a summary.
 */
exports.getStatement = async (req, res, next) => {
  try {
    assertId(req.params.id, 'booking');
    const booking = await Booking.findById(req.params.id)
      .populate({ path: 'plot', populate: { path: 'block', select: 'code name' } })
      .populate({ path: 'project', select: 'code name location company', populate: { path: 'company' } })
      .populate('client')
      .populate('associate', 'memberCode fullName phone email')
      .lean();
    if (!booking) throw httpError('Booking not found.', 404);

    const [rows, receipts] = await Promise.all([
      PlotPayment.find({ booking: booking._id, status: { $ne: INSTALMENT_STATUSES.SUPERSEDED } }).sort({ seq: 1 }).lean(),
      PlotReceipt.find({ booking: booking._id }).sort({ paidOn: 1, createdAt: 1 }).lean()
    ]);
    const today = startOfDay();
    const schedule = rows.map((p) => withDueState(p, today));
    const open = schedule.filter((p) => OPEN_INSTALMENT_STATUSES.includes(p.status));
    const overdue = open.filter((p) => p.overdue);

    res.status(200).json({
      success: true,
      data: {
        ...booking,
        schedule,
        receipts,
        summary: {
          price: booking.price,
          paid: booking.paidTotal,
          balance: booking.status === BOOKING_STATUSES.CANCELLED ? 0 : round2(booking.price - booking.paidTotal),
          emiAmount: booking.emiAmount,
          remainingEmis: open.filter((p) => p.kind === INSTALMENT_KINDS.EMI).length,
          nextDue: open[0] ? { dueDate: open[0].dueDate, amount: open[0].remaining } : null,
          overdue: round2(overdue.reduce((s, p) => s + p.remaining, 0)),
          overdueCount: overdue.length
        },
        generatedAt: new Date()
      }
    });
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 11: Routes** — in `routes/plots/index.js` replace the bookings + payments lines of `salesRouter` with:

```js
salesRouter.get('/bookings/schedule-preview', sales.previewSchedule);
salesRouter.get('/bookings', sales.listBookings);
salesRouter.post('/bookings', sales.createBooking);
salesRouter.get('/bookings/:id', sales.getBooking);
salesRouter.get('/bookings/:id/payment-preview', sales.previewPayment);
salesRouter.post('/bookings/:id/payments', sales.recordPayment);
salesRouter.get('/bookings/:id/statement', sales.getStatement);
salesRouter.post('/bookings/:id/cancel', sales.cancelBooking);

salesRouter.get('/payments', sales.listPayments);
salesRouter.get('/payments/dues', sales.listDues);
salesRouter.get('/payments/:id/receipt', sales.getReceipt);
```

- [ ] **Step 12: Server boots**

Run: `node -e "require('./routes/plots');console.log('routes ok')"` → Expected: `routes ok`.
Run (background): `npm run dev`; wait for its "connected" log; then stop it. Expected: no errors at startup.

- [ ] **Step 13: Scenario harness** — create `<scratchpad>/plotScenarios.js` (scratchpad only). It calls controllers like `seedPlotDemo.js` does:

```js
const path = require('path');
const root = process.argv[2];
const r = (p) => require(path.join(root, p));
require(path.join(root, 'node_modules/dotenv')).config({ path: path.join(root, '.env'), quiet: true });
const mongoose = require(path.join(root, 'node_modules/mongoose'));
const Associate = r('models/Associate');
const Booking = r('models/plots/Booking');
const PlotPayment = r('models/plots/Payment');
const PlotCommission = r('models/plots/Commission');
const sales = r('controllers/plots/salesController');
const { runInBusiness } = r('utils/businessContext');

let user;
const call = (handler, { body = {}, params = {}, query = {} } = {}) =>
  new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { (this.statusCode >= 400 ? reject : resolve)(this.statusCode >= 400 ? Object.assign(new Error(p.message), { status: this.statusCode }) : p); return this; } };
    Promise.resolve(handler({ body, params, query, user, ip: 'scenario' }, res, (e) => reject(e))).catch(reject);
  });
const idOf = async (code) => String((await Booking.findOne({ code }).lean())._id);
const show = async (code) => {
  const b = await Booking.findOne({ code }).lean();
  const rows = await PlotPayment.find({ booking: b._id }).sort({ seq: 1, revision: 1 }).lean();
  console.log(`  ${code} ${b.status} paid ${b.paidTotal}/${b.price} emi ${b.emiAmount} tenure ${b.tenureMonths} rev ${b.revision}`);
  for (const x of rows.filter((x) => x.status !== 'paid' || x.revision > 0).slice(0, 6)) console.log(`    #${x.seq} r${x.revision} ${x.status} ${x.paidAmount}/${x.dueAmount} due ${x.dueDate.toISOString().slice(0, 10)}`);
};
const expectError = async (label, fn, status) => {
  try { await fn(); console.log(`FAIL  ${label} — no error`); } catch (e) { console.log(`${e.status === status ? 'PASS' : 'FAIL'}  ${label} → ${e.status} ${e.message}`); }
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await runInBusiness('t2', async () => {
    user = await Associate.findOne({ role: 'admin' }).lean();
    const today = new Date().toISOString().slice(0, 10);

    console.log('S1 short pay on overdue EMI (BKG-000003)');
    await call(sales.recordPayment, { params: { id: await idOf('BKG-000003') }, body: { amount: 50000, paidOn: today, mode: 'Cash' } });
    await show('BKG-000003');

    console.log('S2 pay ahead 1,00,000 (BKG-000005)');
    const p2 = await call(sales.previewPayment, { params: { id: await idOf('BKG-000005') }, query: { amount: '100000', paidOn: today } });
    console.log(`  preview needsChoice=${p2.data.needsChoice} extra=${p2.data.extra}`);
    await call(sales.recordPayment, { params: { id: await idOf('BKG-000005') }, body: { amount: 100000, paidOn: today, mode: 'UPI', adjustment: 'pay_ahead' } });
    await show('BKG-000005');

    console.log('S3 reduce EMI 2,00,000 (BKG-000006)');
    await call(sales.recordPayment, { params: { id: await idOf('BKG-000006') }, body: { amount: 200000, paidOn: today, mode: 'UPI', adjustment: 'reduce_emi' } });
    await show('BKG-000006');

    console.log('S4 reduce tenure 3,00,000 over a part-paid EMI (BKG-000005)');
    await call(sales.recordPayment, { params: { id: await idOf('BKG-000005') }, body: { amount: 300000, paidOn: today, mode: 'Bank Transfer', adjustment: 'reduce_tenure' } });
    await show('BKG-000005');

    console.log('S5 foreclosure (BKG-000003)');
    const b3 = await Booking.findOne({ code: 'BKG-000003' }).lean();
    await call(sales.recordPayment, { params: { id: String(b3._id) }, body: { amount: Math.round((b3.price - b3.paidTotal) * 100) / 100, paidOn: today, mode: 'Cheque' } });
    await show('BKG-000003');

    console.log('S6 cancel after prepayment (BKG-000006)');
    await call(sales.cancelBooking, { params: { id: await idOf('BKG-000006') }, body: { reason: 'Scenario check', refundAmount: 0 } });
    const b6 = await Booking.findOne({ code: 'BKG-000006' }).lean();
    const net = await PlotCommission.aggregate([{ $match: { booking: b6._id } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
    console.log(`  ${net[0]?.t === 0 ? 'PASS' : 'FAIL'}  BKG-000006 commission nets to ${net[0]?.t}`);
    await show('BKG-000006');

    console.log('S7 errors');
    const id2 = await idOf('BKG-000002');
    await expectError('over balance', () => call(sales.recordPayment, { params: { id: id2 }, body: { amount: 99999999, paidOn: today } }), 400);
    await expectError('zero', () => call(sales.recordPayment, { params: { id: id2 }, body: { amount: 0, paidOn: today } }), 400);
    await expectError('extra without choice', () => call(sales.recordPayment, { params: { id: id2 }, body: { amount: 500000, paidOn: today } }), 400);
    await expectError('completed booking', () => call(sales.recordPayment, { params: { id: await idOf('BKG-000001') }, body: { amount: 1, paidOn: today } }), 409);

    console.log('Statement (BKG-000005)');
    const st = await call(sales.getStatement, { params: { id: await idOf('BKG-000005') } });
    console.log(`  schedule ${st.data.schedule.length} rows, receipts ${st.data.receipts.length}, summary ${JSON.stringify(st.data.summary)}`);
  });
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
```

- [ ] **Step 14: Run the scenarios**

Run: `node <scratchpad>/plotScenarios.js "F:\Freelancing\Real Estate\The-Great-Empire-Software"`
Expected:
- S1: BKG-000003 has one row `partial` with 50000 paid.
- S2: preview `needsChoice=true`; after, next EMIs `paid` and one `partial`.
- S3: BKG-000006 `rev 1`, smaller `emi`, `superseded` rows plus revision-1 rows.
- S4: BKG-000005 `rev 1`, the part-paid row closed as `paid` at its paid amount, fewer EMIs at the old EMI amount.
- S5: BKG-000003 `completed`.
- S6: `PASS BKG-000006 commission nets to 0`, open rows `cancelled`.
- S7: four `PASS` lines.
- Statement prints a summary.

---

### Task 7: Schedule verifier

**Files:**
- Create: `scripts/verifyPlotSchedules.js`
- Modify: `package.json` (add `"verify:plots": "node scripts/verifyPlotSchedules.js",` after `"reconcile:plots"`)

**Interfaces:**
- Produces: `npm run verify:plots` — exit 0 and `All N booking(s) consistent.` or exit 1 with each problem.

- [ ] **Step 1: Create the script**

```js
/**
 * Checks every T2 booking's schedule, receipts and commission agree.
 *
 *   npm run verify:plots
 *
 * Read-only. For each booking:
 *   - live schedule (not superseded) + prepayments = price
 *   - paidTotal = Σ receipts = Σ instalments paid + prepayments
 *   - each receipt's allocations add up to its amount
 *   - completed ⇔ nothing left open (active bookings)
 *   - commission: direct = 5% of Σ commissionBase (live bookings),
 *     every money row reversed (cancelled bookings)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BUSINESSES } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');
const PlotBooking = require('../models/plots/Booking');
const PlotPayment = require('../models/plots/Payment');
const PlotReceipt = require('../models/plots/Receipt');
const PlotCommission = require('../models/plots/Commission');
const { BOOKING_STATUSES, INSTALMENT_STATUSES, OPEN_INSTALMENT_STATUSES, PLOT_COMMISSION, PREPAYMENT } = require('../config/plotConfig');
const { COMMISSION_TYPES } = require('../config/constants');
const { round2 } = require('../services/plots/helpers');

const sum = (xs, f) => round2(xs.reduce((s, x) => s + f(x), 0));
const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  let problems = 0;

  await runInBusiness(BUSINESSES.T2, async () => {
    const bookings = await PlotBooking.find().sort({ code: 1 }).lean();
    for (const b of bookings) {
      const issues = [];
      const [rows, receipts, money] = await Promise.all([
        PlotPayment.find({ booking: b._id, status: { $ne: INSTALMENT_STATUSES.SUPERSEDED } }).lean(),
        PlotReceipt.find({ booking: b._id }).lean(),
        PlotCommission.find({ booking: b._id, amount: { $ne: 0 } }).lean()
      ]);
      const prepaid = sum(receipts, (r) => sum(r.allocations.filter((a) => a.kind === PREPAYMENT), (a) => a.amount));
      const received = sum(receipts, (r) => r.amount);

      if (received !== round2(b.paidTotal)) issues.push(`paidTotal ${b.paidTotal} ≠ receipts ${received}`);
      for (const r of receipts) {
        const allocated = sum(r.allocations, (a) => a.amount);
        if (allocated !== round2(r.amount)) issues.push(`${r.receiptNo}: allocations ${allocated} ≠ amount ${r.amount}`);
      }

      if (b.status !== BOOKING_STATUSES.CANCELLED) {
        const scheduled = round2(sum(rows, (r) => r.dueAmount) + prepaid);
        if (scheduled !== round2(b.price)) issues.push(`schedule + prepayments ${scheduled} ≠ price ${b.price}`);
        const rowsPaid = round2(sum(rows, (r) => r.paidAmount) + prepaid);
        if (rowsPaid !== round2(b.paidTotal)) issues.push(`instalments paid + prepayments ${rowsPaid} ≠ paidTotal ${b.paidTotal}`);
        const open = rows.some((r) => OPEN_INSTALMENT_STATUSES.includes(r.status));
        if (open === (b.status === BOOKING_STATUSES.COMPLETED)) issues.push(`status ${b.status} but ${open ? 'rows still open' : 'nothing open'}`);

        const direct = sum(money.filter((m) => m.type === COMMISSION_TYPES.DIRECT), (m) => m.amount);
        const expected = round2(PLOT_COMMISSION.direct * sum(receipts, (r) => r.commissionBase));
        if (!near(direct, expected, 0.01 * receipts.length)) issues.push(`direct commission ${direct} ≠ ${expected}`);
      } else {
        const net = sum(money, (m) => m.amount);
        if (!near(net, 0)) issues.push(`cancelled but commission nets to ${net}`);
      }

      if (issues.length) {
        problems += issues.length;
        console.log(`${b.code}:`);
        issues.forEach((i) => console.log(`  - ${i}`));
      }
    }
    console.log(problems ? `\n${problems} problem(s).` : `All ${bookings.length} booking(s) consistent.`);
  });

  await mongoose.disconnect();
  if (problems) process.exitCode = 1;
};

run().catch(async (err) => {
  console.error('Verify failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 2: Run verifier and reconcile on the scenario data**

Run: `npm run verify:plots` → Expected: `All 8 booking(s) consistent.`
Run: `npm run reconcile:plots` → Expected: `without commission: 0`, `repaired: 0`.

---

### Task 8: Seed uses the new flow

**Files:**
- Modify: `scripts/dev-seed/seedPlotDemo.js`

**Interfaces:**
- Consumes: `sales.recordPayment` (Task 6).

- [ ] **Step 1: Imports** — change the plotConfig import to `const { PAYMENT_PLANS, RATE_UNITS, INSTALMENT_STATUSES, OPEN_INSTALMENT_STATUSES } = require('../../config/plotConfig');` and add `const { round2 } = require('../../services/plots/helpers');`.

- [ ] **Step 2: Extra payments in the plan** — in `BOOKINGS` add an `extra` list to three entries (keep everything else):
  - A-5 entry: `extra: [{ amount: 50000, paidOn: '2026-09-20' }]` and note `'EMI 6m, 1 EMI paid, next one part-paid and overdue'`
  - B-3 entry: `extra: [{ amount: 300000, paidOn: '2026-10-05', adjustment: 'reduce_tenure' }]` and note `'EMI 24m, first EMI paid, then ₹3L prepaid (reduce tenure)'`
  - C-1 entry: `extra: [{ amount: 150000, paidOn: '2026-10-08', adjustment: 'reduce_emi' }]` and note `'EMI 12m, no down payment, rating 80%, own Right leg, ₹1.5L prepaid (reduce EMI)'`

  Update the file's doc comment line about the flow to mention receipts: `It calls the real controllers with an admin request, so codes, schedules, receipts, prepayments, commission and payouts are the app's own output.`

- [ ] **Step 3: Replace `receive`** and add the extra step:

```js
    const receive = async (bookingId, count) => {
      for (let n = 0; n < count; n++) {
        const next = await PlotPayment.findOne({ booking: bookingId, status: { $in: OPEN_INSTALMENT_STATUSES } }).sort({ seq: 1 }).lean();
        if (!next) return;
        await call(sales.recordPayment, {
          params: { id: String(bookingId) },
          body: { amount: round2(next.dueAmount - next.paidAmount), mode: 'UPI', reference: `UPI ${String(next._id).slice(-8)}`, paidOn: next.dueDate }
        });
      }
    };
```

  and in the bookings loop, right after `if (b.pay) await receive(data._id, b.pay);` add:

```js
      for (const x of b.extra || []) {
        await call(sales.recordPayment, {
          params: { id: String(data._id) },
          body: { amount: x.amount, paidOn: x.paidOn, mode: 'Bank Transfer', reference: 'Seeded prepayment', adjustment: x.adjustment || null }
        });
      }
```

  Update the final count line: `PlotPayment.countDocuments({ status: { $in: OPEN_INSTALMENT_STATUSES } })` for "still due" (keep `INSTALMENT_STATUSES.PAID` for received) and print receipts too: add `PlotReceipt.countDocuments()` (require `../../models/plots/Receipt`) and log `${receipts} receipt(s)`.

- [ ] **Step 4: Run the seed against a throwaway database** (never against `testing`):

```powershell
$line = (Get-Content .env | Select-String '^MONGO_URI=').Line
$env:MONGO_URI = $line.Substring(10) -replace '/testing(?=[?/]|$)', '/seedcheck'
if ($env:MONGO_URI -notmatch '/seedcheck') { throw 'URI rewrite failed — stop' }
npm run seed:admin; npm run seed:plots -- --apply; npm run verify:plots
```

Expected: seed finishes with `Done.`; verifier prints `All 8 booking(s) consistent.`

- [ ] **Step 5: Drop the throwaway databases** (same shell, `$env:MONGO_URI` still points at `seedcheck`):

Run: `node -e "require('dotenv').config({quiet:true});const m=require('mongoose');(async()=>{await m.connect(process.env.MONGO_URI);if(m.connection.name!=='seedcheck')throw new Error('wrong db '+m.connection.name);await m.connection.client.db('seedcheck').dropDatabase();await m.connection.client.db('seedcheck_t2').dropDatabase();console.log('dropped');await m.disconnect()})()"`
Expected: `dropped`. Then `Remove-Item Env:MONGO_URI`.

---

### Task 9: Frontend API types and format helpers

**Files:**
- Modify: `src/api/plots.ts`, `src/features/plots/format.ts`

**Interfaces:**
- Produces: types `InstalmentStatus`, `PaymentAdjustment`, `Instalment`, `ScheduleSnapshot`, `ReceiptAllocation`, `ReceiptAdjustment`, `PlotReceipt`, `BookingDetail` (+`receipts`, `dueNow`), `PaymentPreview`, `PaymentInput`, `PaymentRow`, `DueRow`, `PaymentList`, `DueList`, `Receipt`, `BookingStatement`; functions `previewPayment(bookingId, params)`, `recordPayment(bookingId, body)`, `fetchStatement(id)`; format helpers `ADJUSTMENT_LABEL`, `ADJUSTMENT_HINT`, `allocationLabel`, `adjustmentNote`, `instalmentStatusText`.

- [ ] **Step 1: plots.ts** — replace from `export type InstalmentStatus = …` through the `fetchReceipt` line (keep `downloadPaymentsCsv` below it) with:

```ts
export type InstalmentStatus = 'due' | 'partial' | 'paid' | 'superseded' | 'cancelled'
export type PaymentAdjustment = 'reduce_emi' | 'reduce_tenure' | 'pay_ahead'

export interface Instalment {
  _id: string
  booking: string
  kind: InstalmentKind
  seq: number
  revision: number
  dueDate: string
  dueAmount: number
  paidAmount: number
  /** dueAmount − paidAmount */
  remaining: number
  status: InstalmentStatus
  overdue?: boolean
  lastPaidOn: string | null
}

export interface ScheduleSnapshot {
  count: number
  emi: number
  endDate: string
}
export interface ReceiptAllocation {
  instalment: string | null
  seq: number | null
  kind: InstalmentKind | 'prepayment'
  amount: number
}
export interface ReceiptAdjustment {
  type: PaymentAdjustment
  extra: number
  before: ScheduleSnapshot | null
  after: ScheduleSnapshot | null
}

/** One payment recorded on a booking — and its receipt. */
export interface PlotReceipt {
  _id: string
  booking: string
  receiptNo: string
  amount: number
  paidOn: string
  mode: string | null
  reference: string
  notes: string
  ratingPct: number
  commissionBase: number
  allocations: ReceiptAllocation[]
  adjustment: ReceiptAdjustment | null
  balanceAfter: number
  receivedByCode: string | null
}

export interface Booking {
  _id: string
  code: string
  plot: Plot | Ref
  project: Ref
  client: Client | { _id: string; code: string; fullName: string; mobile: string }
  associate: { _id: string; memberCode: string; fullName: string; phone?: string; email?: string }
  associateCode: string
  /** Placed in the associate's own leg; null = upline only. */
  leg: 'Left' | 'Right' | null
  plan: PaymentPlan
  price: number
  downPayment: number
  /** Live schedule — change when a prepayment reshapes it. */
  tenureMonths: number
  emiAmount: number
  revision: number
  bookedOn: string
  status: BookingStatus
  paidTotal: number
  notes: string
  cancel: { at: string | null; reason: string; refundAmount: number; refundMode: string; refundReference: string }
  createdAt: string
}
export interface BookingDetail extends Booking {
  plot: Plot & { block: Ref }
  client: Client
  schedule: Instalment[]
  receipts: PlotReceipt[]
  balance: number
  /** Owed on instalments due today or earlier. */
  dueNow: number
  nextDue: Instalment | null
}

export interface SchedulePreview {
  price: number
  plan: PaymentPlan
  downPayment: number
  tenureMonths: number
  emiAmount: number
  rows: { kind: InstalmentKind; seq: number; dueDate: string; dueAmount: number }[]
}

export interface SellInput {
  leg?: 'Left' | 'Right' | null
  plot: string
  client: string
  associate: string
  plan: PaymentPlan
  downPayment?: number
  tenureMonths?: number
  bookedOn: string
  notes?: string
  payNow?: { mode: string; reference: string; paidOn: string; ratingPct: number } | null
}

export const previewSchedule = (params: Params) =>
  apiRequest<ApiSingleResponse<SchedulePreview>>('/plot-sales/bookings/schedule-preview', { params })
export const createBooking = (body: SellInput) =>
  apiRequest<ApiSingleResponse<{ _id: string; code: string; receiptPaymentId: string | null }> & { message: string }>(
    '/plot-sales/bookings',
    { method: 'POST', body },
  )
export const fetchBookings = (params: Params = {}) => apiRequest<Paged<Booking>>('/plot-sales/bookings', { params })
export const fetchBooking = (id: string) => apiRequest<ApiSingleResponse<BookingDetail>>(`/plot-sales/bookings/${id}`)
export const cancelBooking = (
  id: string,
  body: { reason: string; refundAmount: number; refundMode: string; refundReference: string },
) => apiRequest<ApiSingleResponse<{ reversed: number }> & { message: string }>(`/plot-sales/bookings/${id}/cancel`, { method: 'POST', body })

export interface PaymentPreview {
  balance: number
  dueNow: number
  extra: number
  needsChoice: boolean
  completes: boolean
  balanceAfter: number
  adjustment: ReceiptAdjustment | null
  allocations: ReceiptAllocation[]
  newSchedule: { seq: number; dueDate: string; dueAmount: number }[]
}
export interface PaymentInput {
  amount: number
  paidOn: string
  mode: string
  reference: string
  notes: string
  ratingPct: number
  adjustment: PaymentAdjustment | null
}
export const previewPayment = (bookingId: string, params: Params) =>
  apiRequest<ApiSingleResponse<PaymentPreview>>(`/plot-sales/bookings/${bookingId}/payment-preview`, { params })
export const recordPayment = (bookingId: string, body: PaymentInput) =>
  apiRequest<ApiSingleResponse<PlotReceipt> & { message: string }>(`/plot-sales/bookings/${bookingId}/payments`, {
    method: 'POST',
    body,
  })

interface SaleRefs {
  booking: { _id: string; code: string; plan: PaymentPlan; status: BookingStatus }
  plot: Ref
  project: Ref
  client: { _id: string; code: string; fullName: string; mobile: string }
  associate: { _id: string; memberCode: string; fullName: string }
}
export type PaymentRow = Omit<PlotReceipt, 'booking'> & SaleRefs
export type DueRow = Omit<Instalment, 'booking'> & SaleRefs
export interface PaymentList extends Paged<PaymentRow> {
  summary: { paid: number }
}
export interface DueList extends Paged<DueRow> {
  summary: { due: number; overdue: number; overdueCount: number }
}
export const fetchPayments = (params: Params = {}) => apiRequest<PaymentList>('/plot-sales/payments', { params })
export const fetchDues = (params: Params = {}) => apiRequest<DueList>('/plot-sales/payments/dues', { params })

export interface Receipt extends Omit<PlotReceipt, 'booking'> {
  booking: {
    _id: string
    code: string
    plan: PaymentPlan
    price: number
    paidTotal: number
    tenureMonths: number
    emiAmount: number
    bookedOn: string
    status: BookingStatus
  }
  plot: { code: string; name: string; size: number; facing: string; block: { name: string } }
  project: { code: string; name: string; location: Project['location']; company: Company }
  client: Client
  /** Balance right after this payment. */
  balance: number
}
export const fetchReceipt = (id: string) => apiRequest<ApiSingleResponse<Receipt>>(`/plot-sales/payments/${id}/receipt`)

export interface BookingStatement extends Omit<BookingDetail, 'project' | 'balance' | 'dueNow' | 'nextDue'> {
  project: { _id: string; code: string; name: string; location: Project['location']; company: Company }
  summary: {
    price: number
    paid: number
    balance: number
    emiAmount: number
    remainingEmis: number
    nextDue: { dueDate: string; amount: number } | null
    overdue: number
    overdueCount: number
  }
  generatedAt: string
}
export const fetchStatement = (id: string) => apiRequest<ApiSingleResponse<BookingStatement>>(`/plot-sales/bookings/${id}/statement`)
```

- [ ] **Step 2: format.ts** — change the first import to

```ts
import type { BookingStatus, Instalment, InstalmentKind, PaymentAdjustment, PaymentPlan, PlotStatus, ProjectStatus, RateUnit, ReceiptAdjustment } from '@/api/plots'
```

and append:

```ts
export const ADJUSTMENT_LABEL: Record<PaymentAdjustment, string> = {
  reduce_emi: 'Reduce EMI amount',
  reduce_tenure: 'Reduce tenure',
  pay_ahead: 'Pay upcoming EMIs',
}

export const ADJUSTMENT_HINT: Record<PaymentAdjustment, string> = {
  reduce_emi: 'Same end date, smaller EMIs',
  reduce_tenure: 'Same EMI, finishes earlier',
  pay_ahead: 'Next EMIs marked paid',
}

/** "EMI 3", "Down payment", "Prepayment" — one line of a receipt. */
export const allocationLabel = (a: { kind: InstalmentKind | 'prepayment'; seq: number | null }) =>
  a.kind === 'prepayment' ? 'Prepayment' : a.kind === 'emi' ? `EMI ${a.seq}` : KIND_LABEL[a.kind]

/** One line explaining what a payment's extra did, or '' when nothing. */
export const adjustmentNote = (adj: ReceiptAdjustment | null) => {
  if (!adj) return ''
  if (adj.type === 'pay_ahead') return `${inr(adj.extra)} paid ahead on upcoming EMIs`
  if (!adj.before || !adj.after) return ''
  return adj.type === 'reduce_emi'
    ? `${inr(adj.extra)} prepaid · EMI ${inr(adj.before.emi)} → ${inr(adj.after.emi)} (${adj.after.count} left)`
    : `${inr(adj.extra)} prepaid · ${adj.before.count} → ${adj.after.count} EMIs, now ending ${day(adj.after.endDate)}`
}

/** Plain-text status for an instalment (statement, print). */
export const instalmentStatusText = (s: Pick<Instalment, 'status' | 'overdue'>) => {
  if (s.status === 'paid') return 'Paid'
  if (s.status === 'cancelled') return 'Cancelled'
  if (s.status === 'superseded') return 'Replaced'
  if (s.status === 'partial') return s.overdue ? 'Part-paid · overdue' : 'Part-paid'
  return s.overdue ? 'Overdue' : 'Due'
}
```

- [ ] **Step 3: Type check** — Run: `npx tsc -b` (from `great-empire`). Expected: errors ONLY in `BookingDetailPage.tsx`, `ReceiptPage.tsx`, `PaymentsPage.tsx`, `DuesPage.tsx` (fixed in Tasks 10–12). Any other file erroring means a type above is wrong — fix it here.

---

### Task 10: Booking page — receive any amount, payments list, statement link

**Files:**
- Rewrite: `src/features/plots/sales/BookingDetailPage.tsx`

**Interfaces:**
- Consumes: Task 9 types and helpers.

- [ ] **Step 1: Replace the file** with:

```tsx
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  cancelBooking,
  fetchBooking,
  previewPayment,
  recordPayment,
  type BookingDetail,
  type Instalment,
  type PaymentAdjustment,
} from '@/api/plots'
import { ApiRequestError } from '@/api/fetchClient'
import { PAYMENT_MODES } from '@/types/referral'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { Textarea } from '@/components/ui/Textarea'
import { DataTable, PageHeader, Section, Stat, Td, Th } from '../PlotUi'
import {
  ADJUSTMENT_HINT,
  ADJUSTMENT_LABEL,
  BOOKING_STATUS_TONE,
  PLAN_LABEL,
  adjustmentNote,
  allocationLabel,
  day,
  inr,
  instalmentLabel,
  rowClass,
  todayIso,
} from '../format'
import { usePlotConfig } from '../hooks'

const errorText = (error: unknown) => (error instanceof ApiRequestError ? error.message : 'Something went wrong.')

const ADJUSTMENTS: PaymentAdjustment[] = ['reduce_emi', 'reduce_tenure', 'pay_ahead']

/** One booking: who, what, the schedule and every payment; receive a payment, print the statement, or cancel. */
export function BookingDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { data, isLoading } = useQuery({ queryKey: ['plot-booking', id], queryFn: () => fetchBooking(id) })
  const [receiving, setReceiving] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [showReplaced, setShowReplaced] = useState(false)

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }
  const b = data?.data
  if (!b) return <p className="text-sm text-danger">Booking not found.</p>

  const active = b.status === 'active'
  const overdue = b.schedule.filter((s) => s.overdue)
  const replaced = b.schedule.filter((s) => s.status === 'superseded')
  const rows = showReplaced ? b.schedule : b.schedule.filter((s) => s.status !== 'superseded')
  const emisLeft = b.schedule.filter((s) => s.kind === 'emi' && (s.status === 'due' || s.status === 'partial')).length

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        title={`Booking ${b.code}`}
        description={`${b.plot.name} · ${b.project?.name} · booked ${day(b.bookedOn)}`}
        back="/admin/plot-sales/bookings"
        actions={
          <>
            <Link to={`/admin/plot-sales/bookings/${b._id}/statement`}>
              <Button variant="secondary">Statement</Button>
            </Link>
            {active && <Button onClick={() => setReceiving(true)}>Receive payment</Button>}
            {b.status !== 'cancelled' && (
              <Button variant="danger" onClick={() => setCancelling(true)}>
                Cancel booking
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Price" value={inr(b.price)} />
        <Stat label="Paid" value={inr(b.paidTotal)} tone="good" />
        <Stat label="Balance" value={inr(b.status === 'cancelled' ? 0 : b.balance)} tone="accent" />
        <Stat
          label={overdue.length ? 'Overdue' : 'Next due'}
          value={
            overdue.length
              ? `${overdue.length} · ${inr(overdue.reduce((s, r) => s + r.remaining, 0))}`
              : b.nextDue
                ? `${inr(b.nextDue.remaining)} · ${day(b.nextDue.dueDate)}`
                : '—'
          }
          tone={overdue.length ? 'warn' : undefined}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Section title="Plot">
          <Info label="Plot" value={`${b.plot.name} (${b.plot.code})`} />
          <Info label="Block" value={b.plot.block?.name} />
          <Info label="Size" value={`${b.plot.size} sq.ft · ${b.plot.width} × ${b.plot.length} ft`} />
          <Info label="Facing" value={b.plot.facing || '—'} />
        </Section>
        <Section title="Client">
          <Info label="Name" value={`${b.client.title ? `${b.client.title} ` : ''}${b.client.fullName} (${b.client.code})`} />
          <Info label="Mobile" value={b.client.mobile} />
          <Info label="Address" value={[b.client.address, b.client.city].filter(Boolean).join(', ') || '—'} />
        </Section>
        <Section title="Sale">
          <Info label="Credited to" value={`${b.associate.memberCode} · ${b.associate.fullName}`} />
          <Info label="Placed in" value={b.leg ? `${b.associate.memberCode}'s ${b.leg.toLowerCase()} leg` : 'Upline only'} />
          <Info
            label="Plan"
            value={b.plan === 'emi' ? `EMI · ${inr(b.downPayment)} down · ${inr(b.emiAmount)} × ${emisLeft} left` : PLAN_LABEL[b.plan]}
          />
          <Info label="Status" value={<Badge tone={BOOKING_STATUS_TONE[b.status]}>{b.status}</Badge>} />
          {b.notes && <Info label="Notes" value={b.notes} />}
        </Section>
      </div>

      {b.status === 'cancelled' && (
        <div className="rounded-card border border-danger-border bg-danger-bg px-5 py-4 text-sm text-text">
          <p className="font-semibold text-danger">Cancelled {day(b.cancel.at)}</p>
          <p className="mt-1">{b.cancel.reason}</p>
          <p className="mt-1 text-text-muted">
            Refunded {inr(b.cancel.refundAmount)}
            {b.cancel.refundMode ? ` by ${b.cancel.refundMode}` : ''}
            {b.cancel.refundReference ? ` (${b.cancel.refundReference})` : ''}. All commission from this booking was reversed.
          </p>
        </div>
      )}

      <Section title="Payment schedule">
        {replaced.length > 0 && (
          <div className="mb-3 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setShowReplaced((v) => !v)}>
              {showReplaced ? 'Hide earlier schedule' : `Show earlier schedule (${replaced.length})`}
            </Button>
          </div>
        )}
        <DataTable
          minWidth={760}
          head={
            <tr>
              <Th>Instalment</Th>
              <Th>Due</Th>
              <Th right>Amount</Th>
              <Th right>Paid</Th>
              <Th>Status</Th>
              <Th>Last paid</Th>
            </tr>
          }
        >
          {rows.map((s) => (
            <tr key={s._id} className={`${rowClass} ${s.status === 'superseded' ? 'opacity-60' : ''}`}>
              <Td className="text-text">{instalmentLabel(s.kind, s.seq, b.tenureMonths)}</Td>
              <Td className="text-text-muted">{day(s.dueDate)}</Td>
              <Td right className="font-medium text-text">
                {inr(s.dueAmount)}
              </Td>
              <Td right className="text-text-muted">
                {s.paidAmount > 0 ? inr(s.paidAmount) : '—'}
                {s.status === 'partial' && <span className="block text-xs text-text-subtle">{inr(s.remaining)} left</span>}
              </Td>
              <Td>
                <InstalmentBadge s={s} />
              </Td>
              <Td className="text-text-muted">{day(s.lastPaidOn)}</Td>
            </tr>
          ))}
        </DataTable>
      </Section>

      <Section title="Payments received">
        {b.receipts.length === 0 ? (
          <p className="text-sm text-text-subtle">No payments yet.</p>
        ) : (
          <DataTable
            minWidth={760}
            head={
              <tr>
                <Th>Receipt</Th>
                <Th>Date</Th>
                <Th>Applied to</Th>
                <Th>Mode</Th>
                <Th right>Amount</Th>
              </tr>
            }
          >
            {b.receipts.map((r) => (
              <tr key={r._id} className={rowClass}>
                <Td>
                  <Link to={`/admin/plot-sales/receipts/${r._id}`} className="font-mono text-xs text-info hover:underline">
                    {r.receiptNo}
                  </Link>
                </Td>
                <Td className="text-text-muted">{day(r.paidOn)}</Td>
                <Td className="text-text-muted">
                  {r.allocations.map(allocationLabel).join(', ')}
                  {r.adjustment && <span className="block text-xs text-text-subtle">{adjustmentNote(r.adjustment)}</span>}
                </Td>
                <Td className="text-text-muted">
                  {r.mode ?? '—'}
                  {r.reference && <span className="block text-xs text-text-subtle">{r.reference}</span>}
                </Td>
                <Td right className="font-medium text-text">
                  {inr(r.amount)}
                  {r.ratingPct !== 100 && <span className="block text-xs text-text-subtle">rating {r.ratingPct}%</span>}
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>

      {receiving && <ReceiveModal booking={b} onClose={() => setReceiving(false)} />}
      {cancelling && <CancelModal booking={b} onClose={() => setCancelling(false)} />}
    </div>
  )
}

function InstalmentBadge({ s }: { s: Instalment }) {
  if (s.status === 'paid') return <Badge tone="success">paid</Badge>
  if (s.status === 'cancelled') return <Badge>cancelled</Badge>
  if (s.status === 'superseded') return <Badge>replaced</Badge>
  const label = s.status === 'partial' ? 'part-paid' : 'due'
  return s.overdue ? <Badge tone="danger">{`${label} · overdue`}</Badge> : <Badge tone="warning">{label}</Badge>
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border py-2 text-sm last:border-0">
      <span className="text-text-subtle">{label}</span>
      <span className="text-right text-text">{value}</span>
    </div>
  )
}

function useRefreshBooking(id: string) {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['plot-booking', id] })
    void queryClient.invalidateQueries({ queryKey: ['plot-statement', id] })
    void queryClient.invalidateQueries({ queryKey: ['plot-bookings'] })
    void queryClient.invalidateQueries({ queryKey: ['plot-payments'] })
    void queryClient.invalidateQueries({ queryKey: ['plot-dues'] })
    void queryClient.invalidateQueries({ queryKey: ['plot-plots'] })
    void queryClient.invalidateQueries({ queryKey: ['plot-commission'] })
  }
}

function ReceiveModal({ booking, onClose }: { booking: BookingDetail; onClose: () => void }) {
  const config = usePlotConfig()
  const refresh = useRefreshBooking(booking._id)
  const suggested = booking.dueNow > 0 ? booking.dueNow : (booking.nextDue?.remaining ?? 0)
  const [amount, setAmount] = useState(suggested ? String(suggested) : '')
  const [paidOn, setPaidOn] = useState(todayIso())
  const [adjustment, setAdjustment] = useState<PaymentAdjustment | null>(null)
  const [mode, setMode] = useState('Cash')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [rating, setRating] = useState('')

  // Typing an amount shouldn't fire a preview per keystroke.
  const [debounced, setDebounced] = useState(amount)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(amount), 300)
    return () => window.clearTimeout(timer)
  }, [amount])

  const preview = useQuery({
    queryKey: ['plot-payment-preview', booking._id, debounced, paidOn, adjustment],
    queryFn: () => previewPayment(booking._id, { amount: debounced, paidOn, adjustment: adjustment ?? undefined }),
    enabled: Number(debounced) > 0,
    retry: false,
  })
  const p = preview.data?.data
  const showChoice = !!p && p.extra > 0 && !p.completes
  const ready = !!p && debounced === amount && !preview.isFetching && !preview.isError && !(showChoice && !adjustment)

  const save = useMutation({
    mutationFn: () =>
      recordPayment(booking._id, {
        amount: Number(amount),
        paidOn,
        mode,
        reference,
        notes,
        ratingPct: rating === '' ? (config.data?.rating.defaultPct ?? 100) : Number(rating),
        adjustment: showChoice ? adjustment : null,
      }),
    onSuccess: (res) => {
      toast.success(res.message)
      refresh()
      onClose()
    },
    onError: (error) => toast.error(errorText(error)),
  })

  return (
    <Modal scrollable open onClose={onClose} title={`Receive payment · ${booking.code}`}>
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) save.mutate()
        }}
      >
        <FormField label="Amount (₹)" htmlFor="rc-amount" required hint={`Up to ${inr(booking.balance)}`}>
          <Input id="rc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </FormField>
        <FormField label="Received on" htmlFor="rc-date">
          <Input id="rc-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          {booking.dueNow > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setAmount(String(booking.dueNow))}>
              Due now {inr(booking.dueNow)}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setAmount(String(booking.balance))}>
            Full balance {inr(booking.balance)}
          </Button>
        </div>

        {showChoice && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium text-text">Apply the extra {inr(p.extra)} as</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {ADJUSTMENTS.map((key) => (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start gap-2 rounded-control border px-3 py-2 text-sm ${
                    adjustment === key ? 'border-info-border bg-info-bg' : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="rc-adjust"
                    value={key}
                    checked={adjustment === key}
                    onChange={() => setAdjustment(key)}
                    className="mt-0.5 accent-[var(--color-info)]"
                  />
                  <span>
                    <span className="block font-medium text-text">{ADJUSTMENT_LABEL[key]}</span>
                    <span className="block text-xs text-text-subtle">{ADJUSTMENT_HINT[key]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="rounded-control bg-info-bg px-4 py-3 text-sm text-text sm:col-span-2">
          <p>
            Due now <strong>{inr(booking.dueNow)}</strong> · Balance <strong>{inr(booking.balance)}</strong> · {booking.client.fullName}
          </p>
          {preview.isError && <p className="mt-1 text-danger">{errorText(preview.error)}</p>}
          {p && !preview.isError && (
            <ul className="mt-2 space-y-0.5 text-text-muted">
              {p.allocations.map((a, i) => (
                <li key={i}>
                  {allocationLabel(a)} — {inr(a.amount)}
                </li>
              ))}
              {p.adjustment && adjustmentNote(p.adjustment) && <li className="text-text">{adjustmentNote(p.adjustment)}</li>}
              {p.completes ? (
                <li className="font-medium text-success">This clears the balance and closes the booking.</li>
              ) : (
                <li>Balance after: {inr(p.balanceAfter)}</li>
              )}
            </ul>
          )}
        </div>

        <FormField label="Mode" htmlFor="rc-mode">
          <Select id="rc-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            {PAYMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Reference" htmlFor="rc-ref" hint="UPI txn id, cheque no …">
          <Input id="rc-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </FormField>
        {config.data?.rating.enabled && (
          <FormField label="Rating %" htmlFor="rc-rating" hint="Share that earns commission.">
            <Input
              id="rc-rating"
              inputMode="decimal"
              placeholder={String(config.data.rating.defaultPct)}
              value={rating}
              onChange={(e) => setRating(e.target.value)}
            />
          </FormField>
        )}
        <FormField label="Notes" htmlFor="rc-notes" className="sm:col-span-2">
          <Textarea id="rc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="success" isLoading={save.isPending} disabled={!ready}>
            Receive payment
          </Button>
        </div>
      </form>
    </Modal>
  )
}
```

Then append the existing `CancelModal` function **unchanged** (copy it from the current file, lines 275–336).

- [ ] **Step 2: Type check** — Run: `npx tsc -b`. Expected: no errors in `BookingDetailPage.tsx`.

---

### Task 11: Booking statement page

**Files:**
- Create: `src/features/plots/sales/StatementPage.tsx`
- Modify: `src/router.tsx` (import + route)

**Interfaces:**
- Consumes: `fetchStatement`, `instalmentStatusText`, `adjustmentNote`, `allocationLabel` (Task 9).

- [ ] **Step 1: Create the page**

```tsx
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchStatement } from '@/api/plots'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { businessName } from '@/lib/business'
import { PageHeader } from '../PlotUi'
import { PLAN_LABEL, adjustmentNote, allocationLabel, day, inr, instalmentLabel, instalmentStatusText } from '../format'

/**
 * A booking's account statement — printable like the receipt: only
 * .print-area survives the print stylesheet, so "Download / Print" doubles as
 * Save as PDF.
 */
export function StatementPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { data, isLoading } = useQuery({ queryKey: ['plot-statement', id], queryFn: () => fetchStatement(id) })

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }
  const s = data?.data
  if (!s) return <p className="text-sm text-danger">Booking not found.</p>

  const company = s.project.company
  const cancelled = s.status === 'cancelled'
  const sum = s.summary

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print">
        <PageHeader
          title={`Statement · ${s.code}`}
          description={`${s.client.fullName} · Plot ${s.plot.name}`}
          back={`/admin/plot-sales/bookings/${s._id}`}
          actions={<Button onClick={() => window.print()}>Download / Print</Button>}
        />
      </div>

      <article className="print-area mx-auto w-full max-w-[900px] bg-white p-8 text-text sm:p-10">
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-border pb-6">
          <div>
            {company?.logo?.url && <img src={company.logo.url} alt="" className="mb-2 h-10 object-contain" />}
            <h2 className="text-lg font-semibold">{company?.name}</h2>
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">{businessName('t2')}</p>
            {company?.address && <p className="mt-1 max-w-xs text-sm text-text-muted">{company.address}</p>}
            <p className="text-sm text-text-muted">{[company?.city, company?.state, company?.pinCode].filter(Boolean).join(', ')}</p>
            {company?.contactNumber && <p className="text-sm text-text-muted">{company.contactNumber}</p>}
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold uppercase tracking-widest text-text-subtle">Account statement</p>
            <p className="mt-1 font-mono text-base font-semibold">{s.code}</p>
            <p className="text-sm text-text-muted">As on {day(s.generatedAt)}</p>
            <p className="text-sm font-medium capitalize">{s.status}</p>
          </div>
        </header>

        <section className="grid gap-6 border-b border-border py-6 sm:grid-cols-3">
          <Block title="Client">
            <p className="font-medium">
              {s.client.title ? `${s.client.title} ` : ''}
              {s.client.fullName}
            </p>
            {s.client.guardianName && <p className="text-sm text-text-muted">C/o {s.client.guardianName}</p>}
            <p className="text-sm text-text-muted">{s.client.mobile}</p>
            <p className="text-sm text-text-muted">{[s.client.address, s.client.city, s.client.state].filter(Boolean).join(', ')}</p>
            <p className="mt-1 font-mono text-xs text-text-subtle">{s.client.code}</p>
          </Block>
          <Block title="Property">
            <p className="font-medium">{s.project.name}</p>
            <p className="text-sm text-text-muted">
              Plot {s.plot.name} · Block {s.plot.block?.name}
            </p>
            <p className="text-sm text-text-muted">
              {s.plot.size} sq.ft · {s.plot.width} × {s.plot.length} ft{s.plot.facing ? ` · ${s.plot.facing}` : ''}
            </p>
          </Block>
          <Block title="Sale">
            <p className="text-sm text-text-muted">Booked on {day(s.bookedOn)}</p>
            <p className="text-sm text-text-muted">
              {PLAN_LABEL[s.plan]}
              {s.plan === 'emi' ? ` · down ${inr(s.downPayment)}` : ''}
            </p>
            <p className="text-sm text-text-muted">
              Associate {s.associate.memberCode} · {s.associate.fullName}
            </p>
          </Block>
        </section>

        <section className="grid grid-cols-2 gap-3 py-6 sm:grid-cols-3">
          <Figure label="Plot price" value={inr(sum.price)} />
          <Figure label="Paid" value={inr(sum.paid)} />
          <Figure label="Balance" value={inr(sum.balance)} strong />
          {s.plan === 'emi' && <Figure label="Current EMI" value={sum.remainingEmis ? `${inr(sum.emiAmount)} × ${sum.remainingEmis}` : '—'} />}
          <Figure label="Next due" value={sum.nextDue ? `${inr(sum.nextDue.amount)} · ${day(sum.nextDue.dueDate)}` : '—'} />
          <Figure label="Overdue" value={sum.overdueCount ? `${inr(sum.overdue)} (${sum.overdueCount})` : 'None'} warn={sum.overdueCount > 0} />
        </section>

        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">Payment schedule</h3>
        <table className="mt-2 w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-subtle">
            <tr>
              <th className="py-2 font-semibold">Instalment</th>
              <th className="py-2 font-semibold">Due date</th>
              <th className="py-2 text-right font-semibold">Amount</th>
              <th className="py-2 text-right font-semibold">Paid</th>
              <th className="py-2 text-right font-semibold">Balance</th>
              <th className="py-2 pl-4 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {s.schedule.map((r) => (
              <tr key={r._id} className="border-b border-border">
                <td className="py-2">{instalmentLabel(r.kind, r.seq, s.tenureMonths)}</td>
                <td className="py-2 text-text-muted">{day(r.dueDate)}</td>
                <td className="py-2 text-right tabular-nums">{inr(r.dueAmount)}</td>
                <td className="py-2 text-right tabular-nums">{r.paidAmount > 0 ? inr(r.paidAmount) : '—'}</td>
                <td className="py-2 text-right tabular-nums">{r.status === 'cancelled' ? '—' : inr(r.remaining)}</td>
                <td className={`py-2 pl-4 ${r.overdue ? 'font-medium text-danger' : 'text-text-muted'}`}>{instalmentStatusText(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="mt-8 text-xs font-semibold uppercase tracking-wide text-text-subtle">Payments received</h3>
        {s.receipts.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">No payments yet.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-subtle">
              <tr>
                <th className="py-2 font-semibold">Receipt</th>
                <th className="py-2 font-semibold">Date</th>
                <th className="py-2 font-semibold">Mode / reference</th>
                <th className="py-2 font-semibold">Applied to</th>
                <th className="py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {s.receipts.map((r) => (
                <tr key={r._id} className="border-b border-border align-top">
                  <td className="py-2 font-mono text-xs">{r.receiptNo}</td>
                  <td className="py-2 text-text-muted">{day(r.paidOn)}</td>
                  <td className="py-2 text-text-muted">
                    {r.mode ?? '—'}
                    {r.reference ? ` · ${r.reference}` : ''}
                  </td>
                  <td className="py-2 text-text-muted">
                    {r.allocations.map(allocationLabel).join(', ')}
                    {r.adjustment && <span className="block text-xs">{adjustmentNote(r.adjustment)}</span>}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">{inr(r.amount)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="py-2 text-right font-semibold">
                  Total received
                </td>
                <td className="py-2 text-right font-semibold tabular-nums">{inr(s.receipts.reduce((t, r) => t + r.amount, 0))}</td>
              </tr>
            </tbody>
          </table>
        )}

        {cancelled && (
          <section className="mt-6 border-t border-border pt-4 text-sm">
            <p className="font-semibold">Booking cancelled on {day(s.cancel.at)}</p>
            <p className="text-text-muted">{s.cancel.reason}</p>
            <p className="text-text-muted">
              Refunded {inr(s.cancel.refundAmount)}
              {s.cancel.refundMode ? ` by ${s.cancel.refundMode}` : ''}
              {s.cancel.refundReference ? ` (${s.cancel.refundReference})` : ''}
            </p>
          </section>
        )}

        <section className="mt-8 grid gap-4 border-t border-border pt-6 text-sm sm:grid-cols-2">
          <p className="text-xs text-text-subtle">This is a computer-generated statement.</p>
          <div className="text-right text-text-muted">
            <p>For {company?.name}</p>
            <p className="mt-10 text-xs">Authorised signatory</p>
          </div>
        </section>
      </article>
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-subtle">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Figure({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-control border border-border px-3 py-2">
      <p className="text-xs text-text-subtle">{label}</p>
      <p className={`tabular-nums ${strong ? 'font-semibold' : ''} ${warn ? 'text-danger' : ''}`}>{value}</p>
    </div>
  )
}
```

- [ ] **Step 2: Route** — in `src/router.tsx` add `import { StatementPage } from '@/features/plots/sales/StatementPage'` after the `ReceiptPage` import, and after `{ path: 'plot-sales/bookings/:id', element: <BookingDetailPage /> },` add:

```tsx
                  { path: 'plot-sales/bookings/:id/statement', element: <StatementPage /> },
```

- [ ] **Step 3: Type check** — Run: `npx tsc -b`. Expected: no errors in `StatementPage.tsx` or `router.tsx`.

---

### Task 12: Receipt, Payments and Dues pages

**Files:**
- Modify: `src/features/plots/sales/ReceiptPage.tsx`, `PaymentsPage.tsx`, `DuesPage.tsx`

- [ ] **Step 1: ReceiptPage** — change the format import to `import { PLAN_LABEL, adjustmentNote, day, inr, instalmentLabel } from '../format'`. Replace the `<table>…</table>` and the totals `<div className="mt-4 ml-auto …">…</div>` with:

```tsx
        <table className="mt-6 w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-subtle">
            <tr>
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {r.allocations.map((a, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-3">
                  {a.kind === 'prepayment' ? 'Prepayment (towards principal)' : instalmentLabel(a.kind, a.seq ?? 0, tenure)} — plot {r.plot.name}
                </td>
                <td className="py-3 text-right font-medium tabular-nums">{inr(a.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.adjustment && adjustmentNote(r.adjustment) && <p className="mt-3 text-sm text-text-muted">{adjustmentNote(r.adjustment)}</p>}

        <div className="mt-4 ml-auto w-full max-w-xs text-sm">
          <Row label="Received" value={inr(r.amount)} strong />
          <Row label="Plot price" value={inr(r.booking.price)} />
          <Row label="Balance after this payment" value={inr(r.balance)} />
        </div>
```

  In the bottom `<dl>` add `{r.notes && <p>Notes: {r.notes}</p>}` after the reference line.

- [ ] **Step 2: PaymentsPage** — make these edits:
  - import line: `import { downloadPaymentsCsv, fetchPayments, type InstalmentKind } from '@/api/plots'` stays; change the format import to `import { adjustmentNote, allocationLabel, day, inr, rowClass } from '../format'`.
  - kind state: `const [kind, setKind] = useState<'' | InstalmentKind | 'prepayment'>('')`, its Select `onChange` cast to the same union, and add `<option value="prepayment">Prepayment</option>` after the EMI option.
  - table head: rename `<Th>Type</Th>` to `<Th>Applied to</Th>`.
  - the Type cell becomes:

```tsx
                <Td className="text-text-muted">
                  {p.allocations.map(allocationLabel).join(', ')}
                  {p.adjustment && <span className="block text-xs text-text-subtle">{adjustmentNote(p.adjustment)}</span>}
                </Td>
```

  - the Amount cell's `{inr(p.paidAmount)}` becomes `{inr(p.amount)}`.

- [ ] **Step 3: DuesPage** — make these edits:
  - the status badge span becomes:

```tsx
                  <span className="mt-1 block">
                    <Badge tone={p.overdue ? 'danger' : 'warning'}>
                      {`${p.status === 'partial' ? 'part-paid' : 'due'}${p.overdue ? ' · overdue' : ''}`}
                    </Badge>
                  </span>
```

  - the Amount cell becomes:

```tsx
                <Td right className="font-medium text-text">
                  {inr(p.remaining)}
                  {p.status === 'partial' && <span className="block text-xs text-text-subtle">of {inr(p.dueAmount)}</span>}
                </Td>
```

  - change the page description to `"Instalments due on or before a date, oldest first — what is still owed on each. Overdue ones are flagged."`

- [ ] **Step 4: Lint and build**

Run: `npm run lint` → Expected: no errors.
Run: `npm run build` → Expected: build succeeds.

---

### Task 13: Browser check

**Files:** none.

- [ ] **Step 1: Start both servers** — backend `npm run dev` (background, backend folder), frontend `npm run dev` (background, frontend folder).

- [ ] **Step 2: Walk through in the browser** (admin login, switch to Plots/T2):
  - Bookings → BKG-000002: schedule shows paid rows, the Payments received table lists receipts with links; "Statement" opens the statement; "Download / Print" opens the print dialog with only the paper area.
  - Receive payment on BKG-000002 with an amount above due now: the three choices appear with the extra amount; choosing "Reduce EMI amount" shows the preview note; Receive is disabled until a choice is made; after saving the schedule shows replaced rows behind "Show earlier schedule", the plan line shows the new EMI.
  - Enter more than the balance: the preview shows the error and Receive stays disabled.
  - "Full balance" quick-fill: preview says it closes the booking.
  - Payments page: rows are receipts with "Applied to"; CSV export downloads.
  - Dues page: part-paid rows show what is left "of" the full amount.
  - A receipt page: allocation lines, adjustment note, balance after.
  - Check the statement and modal at phone width (≈390px): no horizontal page scroll.

- [ ] **Step 3: Final consistency** — Run: `npm run verify:plots` (backend). Expected: `All 8 booking(s) consistent.`
