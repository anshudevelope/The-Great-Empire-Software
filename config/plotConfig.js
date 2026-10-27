// T2 (Plots) — every rate, switch and enum the property and plot-sales modules
// use. Change a number here; nothing in services or controllers hard-codes it.
//
// Rates here are only ever read for NEW rows. Every ledger row freezes the rate
// it used (basis.rate), so changing a value never moves money already earned.

// Commission on plot payments. Paid to the associate a sale is credited to
// (direct) and up their upline (matching), on every payment as it is received —
// once the booking has reached its project's Allotment %. Payments before that
// are held and released together by the payment that reaches it.
const PLOT_COMMISSION = { direct: 0.05, matching: 0.05 };

// Placing a sale in the credited associate's OWN left or right leg (chosen per
// sale, optional). The business then counts in that associate's own leg —
// so they build their own matching — and still flows up to their upline as
// usual. They earn direct AND matching on such sales. Off → every sale goes
// to the upline only, as before.
const PLOT_SELF_LEG = { enabled: true };

// Deductions on a plot payout, as a share of the gross. Frozen onto each payout
// when it is generated.
const PLOT_PAYOUT = { adminChargePct: 0.05, tdsPct: 0.05 };

// The share of a payment that counts as commissionable business — the same
// idea as a registration's rating in T1. Disabled → always 100%.
const PLOT_RATING = { enabled: true, defaultPct: 100 };

const PAYMENT_PLANS = { ONE_TIME: 'one_time', EMI: 'emi' };

const PLOT_PAYMENT = {
  oneTime: { enabled: true },
  emi: {
    enabled: true,
    // Months offered in the Sell form.
    tenures: [3, 6, 12, 18, 24, 36],
    // Reserved. EMIs are interest-free while this is off.
    interest: { enabled: false, annualPct: 0 }
  }
};

// Codes minted from per-business counters.
const CODES = {
  company: { sequence: 'companyCode', prefix: 'COMP', pad: 5 }, // COMP00001
  project: { sequence: 'projectCode', prefix: 'PROJ', pad: 5 },
  block: { sequence: 'blockCode', prefix: 'BLOC', pad: 5 },
  plot: { sequence: 'plotCode', prefix: 'PLOT', pad: 5 },
  client: { sequence: 'clientCode', prefix: 'CUST', pad: 5 },
  booking: { sequence: 'bookingNo', prefix: 'BKG-', pad: 6 }, // BKG-000001
  receipt: { sequence: 'receiptNo', prefix: 'RCP-', pad: 6 }, // RCP-2026-000001, restarts yearly
  payout: { sequence: 'plotPayoutNo', prefix: 'PPY-', pad: 6 } // PPY-000001
};

const PLOT_FACINGS = ['Road Facing', 'Park Facing', 'Corner', 'East', 'West', 'North', 'South', 'Other'];

const RATE_UNITS = { PER_SQFT: 'per_sqft', PER_PLOT: 'per_plot' };

const RECORD_STATUSES = { ACTIVE: 'active', INACTIVE: 'inactive' };

const PROJECT_STATUSES = { UPCOMING: 'upcoming', ONGOING: 'ongoing', COMPLETED: 'completed' };

const PLOT_STATUSES = { AVAILABLE: 'available', HOLD: 'hold', BOOKED: 'booked' };

// PENDING: sold with a first payment that can still bounce (a cheque). The
// plot is held and the schedule exists, but nothing counts as paid and no
// commission runs until the admin approves it; cancelling frees the plot.
const BOOKING_STATUSES = { PENDING: 'pending', ACTIVE: 'active', COMPLETED: 'completed', CANCELLED: 'cancelled' };

// Payment modes that, collected at sale, keep the booking PENDING until approved.
const PENDING_PAYMENT_MODES = ['Cheque'];

const INSTALMENT_KINDS = { FULL: 'full', DOWN: 'down', EMI: 'emi' };

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

// Most plots a single block create / "add plots" call may generate.
const MAX_PLOTS_PER_CALL = 1000;

// What the frontend may read (GET /api/plot-config). Nothing secret lives here,
// but the list is explicit so a future server-only setting never leaks.
const publicPlotConfig = () => ({
  commission: PLOT_COMMISSION,
  selfLeg: PLOT_SELF_LEG,
  payout: { adminChargePct: PLOT_PAYOUT.adminChargePct, tdsPct: PLOT_PAYOUT.tdsPct },
  rating: PLOT_RATING,
  payment: PLOT_PAYMENT,
  adjustments: Object.values(PAYMENT_ADJUSTMENTS),
  pendingPaymentModes: PENDING_PAYMENT_MODES,
  facings: PLOT_FACINGS,
  rateUnits: Object.values(RATE_UNITS),
  projectStatuses: Object.values(PROJECT_STATUSES),
  maxPlotsPerCall: MAX_PLOTS_PER_CALL
});

module.exports = {
  PLOT_COMMISSION,
  PLOT_SELF_LEG,
  PLOT_PAYOUT,
  PLOT_RATING,
  PAYMENT_PLANS,
  PLOT_PAYMENT,
  CODES,
  PLOT_FACINGS,
  RATE_UNITS,
  RECORD_STATUSES,
  PROJECT_STATUSES,
  PLOT_STATUSES,
  BOOKING_STATUSES,
  PENDING_PAYMENT_MODES,
  INSTALMENT_KINDS,
  INSTALMENT_STATUSES,
  OPEN_INSTALMENT_STATUSES,
  PAYMENT_ADJUSTMENTS,
  PREPAYMENT,
  MAX_PLOTS_PER_CALL,
  publicPlotConfig
};
