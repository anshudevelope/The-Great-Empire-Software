# Flexible EMI payments and booking statement — design

Date: 2026-10-11 · Scope: T2 (Plots) backend `The-Great-Empire-Software` and frontend `great-empire`.

## Goal

Let the admin record whatever a plot client actually pays, the way a bank
handles a loan: short payments, payments covering several EMIs, and
prepayments that reshape the remaining schedule. Add a downloadable booking
statement.

Today an instalment can only be received in full, in order, one at a time, and
the schedule never changes after the sale.

## Decisions (agreed)

- Any amount from ₹1 to the outstanding balance is accepted.
- Money always clears what is due now first, oldest first. "Due now" = every
  `due`/`partial` instalment with dueDate ≤ the payment date.
- A short payment leaves that instalment `partial`; the remainder stays due on
  the same date (and is overdue once that date passes). Nothing else moves.
- Money beyond what is due now ("extra") is applied as the admin chooses on
  each payment:
  - `reduce_emi` — same number of remaining EMIs on the same dates, smaller.
  - `reduce_tenure` — same EMI amount, fewer EMIs, finishes earlier.
  - `pay_ahead` — fills the next instalments in order, no reshape.
- An amount equal to the full balance closes the booking; no choice asked.
- EMIs stay interest-free. Already-paid instalments are never changed.
- Commission stays per payment, on `amount × rating%`, settled after commit.
- Approach A: receipts separate from the schedule.

## Data model

### New `PlotReceipt` (`models/plots/Receipt.js`, T2 only)

One per payment the admin records.

| Field | Notes |
|---|---|
| booking, plot, project, client, associate | refs, as on PlotPayment today |
| amount | > 0, ≤ balance at the time |
| paidOn | date received |
| mode, reference, notes | as today |
| ratingPct, commissionBase | `commissionBase = round2(amount × ratingPct/100)` in a pre-validate hook |
| receiptNo | `RCP-YYYY-NNNNNN`, existing yearly counter; unique |
| receivedBy, receivedByCode | admin |
| allocations | `[{ instalment, seq, kind, amount }]` — where the money went |
| adjustment | `null` or `{ type: reduce_emi \| reduce_tenure \| pay_ahead, extra, before: { count, emi, endDate }, after: { count, emi, endDate } }` |
| balanceAfter | booking balance right after this receipt |

Indexes: `receiptNo` unique, `booking + paidOn`, `paidOn`, `project`.

### `PlotPayment` becomes a pure schedule row

- `paidAmount` accumulates across receipts.
- Status enum: `due`, `partial`, `paid`, `superseded`, `cancelled`.
- New `revision` (default 0). Unique index changes from `(booking, seq)` to
  `(booking, seq, revision)`.
- Removed (moved to receipt): `paidOn`, `mode`, `reference`, `notes`,
  `ratingPct`, `commissionBase`, `receiptNo`, `receivedBy`, `receivedByCode`
  and the `commissionBase` hook. A `lastPaidOn` date is kept for display.

### `PlotBooking`

- New `revision` (default 0).
- `emiAmount` and `tenureMonths` always describe the current live schedule
  (updated on reshape). `downPayment` stays as sold.

### `PlotCommission`

- `payment` ref changes to `PlotReceipt`. Idempotency keys keep the same shape
  (`plot:direct:<receiptId>`, `plot:volume:<receiptId>`, `plot:match:…`).

## Applying a payment — `services/plots/receiptService.js`

`applyPayment({ bookingId, amount, paidOn, mode, reference, notes, ratingPct, adjustment, actor })`,
one transaction:

1. Load the active booking and its live rows (`due`/`partial`, current
   revision) by seq. Reject if the booking is not active, `amount ≤ 0`, or
   `amount > balance`.
2. Fill due-now rows oldest first; the last one touched may become `partial`.
3. `extra = amount − applied`. If `extra > 0`:
   - `extra === remaining balance` → fill every remaining row (foreclosure).
   - otherwise `adjustment` is required (400 if missing):
     - `pay_ahead` — keep filling future rows in order.
     - `reduce_emi` / `reduce_tenure` — pure function
       `reshape({ rows, extra, mode })` in `scheduleService` returns the new
       rows; the old unpaid future rows go `superseded`, the new rows are
       inserted with `revision + 1`, the booking's revision / emiAmount /
       tenureMonths are updated. A `partial` future row (from an earlier
       pay-ahead) has its paid part kept: it is closed as `paid` at its paid
       amount before reshaping, and only the unpaid balance is reshaped.
     - The extra is recorded as an allocation of kind `prepayment`
       (`instalment: null`) so allocations always sum to `amount`.
   - Reshape needs at least one future row; with none, the extra must equal
     the balance (covered above).
4. Update `paidTotal`; booking → `completed` when no `due`/`partial` rows remain.
5. Create the receipt (receipt number minted inside the transaction).
6. After commit: `settleReceipt(receipt._id)`, then audit `plot.payment_received`.

### Reshape maths (pure, in `scheduleService`)

Let `B` = unpaid balance of the future rows, `n` = their count, `E` = current
EMI, dates = their due dates.

- reduce_emi: `B' = B − extra`; `n` rows on the same dates, each
  `round2(B'/n)`, last absorbs rounding.
- reduce_tenure: `B' = B − extra`; `m = ceil(B'/E)` rows on the first `m`
  dates, each `E`, last = `B' − E×(m−1)`.

Invariant checked in code: live rows' `dueAmount` sum + prepayment
allocations + superseded rows' paid parts = booking price.

`previewPayment(bookingId, amount, paidOn, adjustment)` runs steps 1–3 without
writing, for the form's live preview.

## Commission

- `onPaymentReceived` / `settlePayment` take a receipt id and read
  `PlotReceipt` (`commissionBase`, `amount`, `ratingPct`). Logic unchanged.
- `reverseBooking` sums `commissionBase` / `amount` from receipts.
- `reconcile:plots` iterates receipts instead of paid instalments.
- `postOwnLegForPayment` reads receipts.

## API (`/api/plot-sales`)

| Method | Path | Change |
|---|---|---|
| GET | `/bookings/:id` | adds `receipts`, `dueNow`, `balance`, `revision`; schedule includes `superseded` rows flagged |
| GET | `/bookings/:id/payment-preview?amount&paidOn&adjustment` | new — preview of allocation and new schedule |
| POST | `/bookings/:id/payments` | new — record a payment (replaces `/payments/:id/receive`) |
| GET | `/bookings/:id/statement` | new — everything the statement prints |
| GET | `/payments` (+ CSV) | lists receipts |
| GET | `/payments/dues` | `due` + `partial` rows; amounts are what is left |
| GET | `/payments/:id/receipt` | `:id` is a receipt id |
| POST | `/bookings` | sale with `payNow` creates a receipt through `applyPayment` |

`POST /payments/:id/receive` is removed.

## Frontend (`great-empire/src/features/plots/sales`)

- **BookingDetailPage** — "Receive payment" opens a modal: amount (shows Due
  now / Balance), date, mode, reference, rating %, notes; when amount > due
  now and < balance, a required choice of the three adjustments with a live
  preview (from `payment-preview`); at full balance a "closes the booking"
  note. Schedule shows `partial` (paid / due) badges; superseded rows behind a
  "Show earlier schedule" toggle. New Payments section listing receipts with
  receipt links. New "Statement" button.
- **StatementPage** (new, route `plot-sales/bookings/:id/statement`) — same
  print layout as ReceiptPage (`.print-area`, "Download / Print"): company
  header, client and plot details, associate, plan, summary (price, paid,
  balance, current EMI × remaining, next due, overdue), schedule table,
  payments table with prepayment notes, refund block when cancelled. Back
  icon beside the title.
- **DuesPage** — shows remaining amount on partial rows.
- **PaymentsPage** — receipts, with "applied to" column.
- **ReceiptPage** — reads the receipt; shows allocations, any adjustment note,
  balance after.
- **SellPlotPage** — unchanged UI.
- `api/plots.ts` types updated accordingly.

## Migration — `scripts/migratePlotReceipts.js` (`npm run migrate:plot-receipts`)

Dry run by default, `--apply` to write, idempotent:

1. For each `PlotPayment` with `status: paid` and a `receiptNo`, create a
   `PlotReceipt` with the **same `_id`**, copying amount (`paidAmount`),
   paidOn, mode, reference, notes, rating, commissionBase, receiptNo,
   receivedBy; one allocation to that row; `adjustment: null`.
2. Unset the moved fields on the instalment rows; set `revision: 0` and
   `lastPaidOn`.
3. Rebuild the PlotPayment indexes (drop `booking_1_seq_1`, create the new
   unique index); create PlotReceipt indexes.

Commission rows need no change because receipt ids equal the old payment ids.

## Out of scope

Interest, late fees, automated reminders, reversing a wrong receipt, changing
plan or tenure outside a prepayment.

## Verification (no test files — per project preference)

- Migration dry run, then `--apply`, on the seeded T2 data; counts and totals
  match before/after.
- Through the API on seeded bookings: short pay → partial; pay ahead; reduce
  EMI; reduce tenure; foreclosure; cancel after a prepayment (commission fully
  reversed, refund cap holds).
- After each: live schedule + prepayments sum to price; booking `paidTotal` =
  sum of receipts; commission direct total = 5% of receipts' commissionBase.
- `reconcile:plots` reports nothing missing.
- Update `seed:plots` to use the new flow.
- Frontend lint + build; check booking, receive modal, statement print,
  dues, payments and receipt pages in the browser.
