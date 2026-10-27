const mongoose = require('mongoose');
const Associate = require('../../models/Associate');
const Client = require('../../models/plots/Client');
const Plot = require('../../models/plots/Plot');
const Booking = require('../../models/plots/Booking');
const PlotPayment = require('../../models/plots/Payment');
const PlotReceipt = require('../../models/plots/Receipt');
const { record } = require('../../services/auditService');
const { withTransaction } = require('../../utils/transaction');
const { streamCsv } = require('../../utils/csv');
const { ROLES, STATUSES, TREE_STATUSES, PAYMENT_MODES, POSITIONS } = require('../../config/constants');
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
  PENDING_PAYMENT_MODES,
  PREPAYMENT
} = require('../../config/plotConfig');
const { buildSchedule, validatePlan } = require('../../services/plots/scheduleService');
const receiptService = require('../../services/plots/receiptService');
const { settlePayment, reverseBooking, allotmentOf } = require('../../services/plots/commissionService');
const {
  round2,
  httpError,
  assertId,
  pageOf,
  listResponse,
  searchFilter,
  nextCode,
  numberOr,
  PLOT_ACTIONS
} = require('../../services/plots/helpers');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// Start of today in server time — "due" / "overdue" boundaries.
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// A pending booking's instalments aren't owed until its cheque is approved, so
// the dues and EMI lists leave them out.
const notPending = async () => ({ $nin: await Booking.find({ status: BOOKING_STATUSES.PENDING }).distinct('_id') });

// ===========================================================================
// Clients
// ===========================================================================
const clientFields = (body) => {
  const fullName = str(body.fullName);
  const mobile = str(body.mobile);
  if (!fullName || !mobile) throw httpError('Client name and mobile are required.');
  if (!/^\d{10}$/.test(mobile)) throw httpError('Mobile must be 10 digits.');
  const data = {
    title: str(body.title),
    fullName,
    guardianName: str(body.guardianName),
    gender: ['Male', 'Female', 'Other'].includes(body.gender) ? body.gender : '',
    dob: body.dob ? new Date(body.dob) : null,
    mobile,
    email: str(body.email).toLowerCase(),
    address: str(body.address),
    city: str(body.city),
    state: str(body.state),
    pinCode: str(body.pinCode),
    idProof: {
      type: str(body.idProof?.type),
      number: str(body.idProof?.number),
      file: { url: str(body.idProof?.file?.url ?? body.idProof?.file), publicId: null }
    },
    notes: typeof body.notes === 'string' ? body.notes : ''
  };
  if (Object.values(RECORD_STATUSES).includes(body.status)) data.status = body.status;
  return data;
};

const assertMobileFree = async (mobile, excludeId = null) => {
  const clash = await Client.findOne({ mobile, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('code').lean();
  if (clash) throw httpError(`A client with this mobile already exists (${clash.code}).`, 409);
};

exports.listClients = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['code', 'fullName', 'mobile', 'email']) };
    if (req.query.status) filter.status = req.query.status;
    const [rows, total] = await Promise.all([
      Client.find(filter).sort({ code: -1 }).skip(skip).limit(limit).lean(),
      Client.countDocuments(filter)
    ]);
    return listResponse(res, { rows, total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.getClient = async (req, res, next) => {
  try {
    assertId(req.params.id, 'client');
    const client = await Client.findById(req.params.id).lean();
    if (!client) throw httpError('Client not found.', 404);
    const bookings = await Booking.find({ client: client._id })
      .populate('plot', 'code name')
      .populate('project', 'code name')
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, data: { ...client, bookings } });
  } catch (error) {
    next(error);
  }
};

exports.findClientByMobile = async (req, res, next) => {
  try {
    const client = await Client.findOne({ mobile: str(req.params.mobile) }).lean();
    res.status(200).json({ success: true, data: client || null });
  } catch (error) {
    next(error);
  }
};

exports.createClient = async (req, res, next) => {
  try {
    const data = clientFields(req.body);
    await assertMobileFree(data.mobile);
    const client = await Client.create({ ...data, code: await nextCode('client') });
    await record(req, { action: PLOT_ACTIONS.CLIENT_SAVED, targetType: 'PlotClient', target: client._id, targetCode: client.code });
    res.status(201).json({ success: true, message: 'Client added.', data: client });
  } catch (error) {
    next(error);
  }
};

exports.updateClient = async (req, res, next) => {
  try {
    assertId(req.params.id, 'client');
    const data = clientFields(req.body);
    await assertMobileFree(data.mobile, req.params.id);
    const client = await Client.findByIdAndUpdate(req.params.id, data, { returnDocument: 'after', runValidators: true });
    if (!client) throw httpError('Client not found.', 404);
    await record(req, { action: PLOT_ACTIONS.CLIENT_SAVED, targetType: 'PlotClient', target: client._id, targetCode: client.code });
    res.status(200).json({ success: true, message: 'Client updated.', data: client });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// Selling
// ===========================================================================
const planInput = (body, price) => {
  const plan = body.plan;
  const downPayment = round2(numberOr(body.downPayment, 0));
  const tenureMonths = plan === PAYMENT_PLANS.EMI ? numberOr(body.tenureMonths, 0) : 0;
  if (Number.isNaN(downPayment)) throw httpError('Down payment must be a number.');
  validatePlan({ plan, price, downPayment, tenureMonths });
  return { plan, downPayment: plan === PAYMENT_PLANS.EMI ? downPayment : 0, tenureMonths };
};

const bookedOnOf = (value) => {
  const d = value ? new Date(value) : startOfDay();
  if (Number.isNaN(d.getTime())) throw httpError('Invalid booking date.');
  return d;
};

// The discount off the plot's list price, and what the client then pays.
const salePrice = (listPrice, value) => {
  const discount = round2(numberOr(value, 0));
  if (Number.isNaN(discount)) throw httpError('Discount must be a number.');
  if (discount < 0) throw httpError('Discount cannot be negative.');
  if (discount >= listPrice) throw httpError('Discount must be less than the plot price.');
  return { listPrice, discount, price: round2(listPrice - discount) };
};

const ratingOf = (value) => {
  if (!PLOT_RATING.enabled) return 100;
  const n = numberOr(value, PLOT_RATING.defaultPct);
  if (!(n >= 0 && n <= 100)) throw httpError('Rating must be between 0 and 100.');
  return n;
};

// What the Sell form shows before submitting. Same maths the sale will use.
exports.previewSchedule = async (req, res, next) => {
  try {
    let listPrice = numberOr(req.query.price, NaN);
    if (req.query.plot) {
      assertId(req.query.plot, 'plot');
      const plot = await Plot.findById(req.query.plot).select('totalPrice').lean();
      if (!plot) throw httpError('Plot not found.', 404);
      listPrice = plot.totalPrice;
    }
    if (!(listPrice >= 0)) throw httpError('Plot price is required.');
    const sale = salePrice(listPrice, req.query.discount);
    const plan = planInput(req.query, sale.price);
    const schedule = buildSchedule({ ...plan, price: sale.price, bookedOn: bookedOnOf(req.query.bookedOn) });
    res.status(200).json({ success: true, data: { ...sale, ...plan, ...schedule } });
  } catch (error) {
    next(error);
  }
};

/**
 * Sell a plot: claim it, create the booking and its whole schedule, and — when
 * the first payment is collected on the spot — receive it, all in one
 * transaction. Commission on that payment runs after commit.
 */
exports.createBooking = async (req, res, next) => {
  try {
    const { plot: plotId, client: clientId, associate: associateId } = req.body;
    assertId(plotId, 'plot');
    assertId(clientId, 'client');
    assertId(associateId, 'associate');

    const [plot, client, associate] = await Promise.all([
      Plot.findById(plotId).populate('project', 'allotmentPct').lean(),
      Client.findById(clientId).lean(),
      Associate.findById(associateId).select('memberCode fullName role status treeStatus').lean()
    ]);
    if (!plot) throw httpError('Plot not found.', 404);
    if (!client) throw httpError('Client not found.', 404);
    if (client.status !== RECORD_STATUSES.ACTIVE) throw httpError('That client is inactive.');
    if (!associate || associate.role !== ROLES.ASSOCIATE) throw httpError('Associate not found.', 404);
    if (associate.status !== STATUSES.APPROVED || associate.treeStatus === TREE_STATUSES.UNPLACED) {
      throw httpError('Associate must be approved and placed in the tree.');
    }

    // Optional: place the sale in the associate's own Left / Right leg.
    const leg = req.body.leg || null;
    if (leg !== null) {
      if (!PLOT_SELF_LEG.enabled) throw httpError('Placing a sale in an associate\'s own leg is not enabled.');
      if (![POSITIONS.LEFT, POSITIONS.RIGHT].includes(leg)) throw httpError('Leg must be Left or Right.');
    }

    const { listPrice, discount, price } = salePrice(plot.totalPrice, req.body.discount);
    const allotmentPct = plot.project?.allotmentPct ?? 0;
    const plan = planInput(req.body, price);
    const bookedOn = bookedOnOf(req.body.bookedOn);
    const { rows, emiAmount } = buildSchedule({ ...plan, price, bookedOn });

    // Optional: collect the first instalment now.
    const payNow = req.body.payNow && typeof req.body.payNow === 'object' ? req.body.payNow : null;
    if (payNow && payNow.mode && !PAYMENT_MODES.includes(payNow.mode)) throw httpError('Unknown payment mode.');
    const rating = payNow ? ratingOf(payNow.ratingPct) : null;
    // A cheque can bounce: the booking waits as PENDING, holding the plot,
    // and the payment is only received when the admin approves it.
    const pending = !!payNow && PENDING_PAYMENT_MODES.includes(payNow.mode);
    const firstPaidOn = payNow?.paidOn ? new Date(payNow.paidOn) : bookedOn;
    if (payNow && Number.isNaN(firstPaidOn.getTime())) throw httpError('Invalid payment date.');

    const { booking, paidId } = await withTransaction(async (session) => {
      // The guarded claim is what stops two admins selling the same plot.
      const claimed = await Plot.findOneAndUpdate(
        {
          _id: plot._id,
          status: { $in: [PLOT_STATUSES.AVAILABLE, PLOT_STATUSES.HOLD] },
          recordStatus: RECORD_STATUSES.ACTIVE
        },
        { $set: { status: PLOT_STATUSES.BOOKED, hold: { note: '', at: null, by: null } } },
        { session, returnDocument: 'after' }
      );
      if (!claimed) throw httpError('Plot is not available.', 409);

      const [created] = await Booking.create(
        [
          {
            code: await nextCode('booking', session),
            plot: plot._id,
            project: plot.project._id,
            client: client._id,
            associate: associate._id,
            associateCode: associate.memberCode,
            leg,
            ...plan,
            emiAmount,
            price,
            listPrice,
            discount,
            allotmentPct,
            bookedOn,
            notes: str(req.body.notes),
            soldBy: req.user._id,
            ...(pending
              ? {
                  status: BOOKING_STATUSES.PENDING,
                  pendingPayment: {
                    amount: rows[0].dueAmount,
                    paidOn: firstPaidOn,
                    mode: payNow.mode,
                    reference: str(payNow.reference),
                    ratingPct: rating
                  }
                }
              : {})
          }
        ],
        { session }
      );
      await Plot.updateOne({ _id: plot._id }, { $set: { currentBooking: created._id } }, { session });

      const docs = rows.map((r) => ({
        ...r,
        booking: created._id,
        plot: plot._id,
        project: plot.project._id,
        client: client._id,
        associate: associate._id
      }));

      // create() rather than insertMany so validation runs.
      await PlotPayment.create(docs, { session, ordered: true });

      // Collecting the first instalment on the spot is an ordinary payment of
      // its amount. pay_ahead covers a plan with no down payment, where the
      // first EMI falls a month after booking.
      const receipt = payNow && !pending
        ? await receiptService.recordPayment(
            {
              bookingId: created._id,
              amount: docs[0].dueAmount,
              paidOn: firstPaidOn,
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
    });

    if (paidId) await settlePayment(paidId);

    await record(req, {
      action: PLOT_ACTIONS.BOOKING_CREATED,
      targetType: 'PlotBooking',
      target: booking._id,
      targetCode: booking.code,
      after: { plot: plot.code, client: client.code, associate: associate.memberCode, leg, listPrice, discount, price, plan: plan.plan, status: booking.status }
    });

    res.status(201).json({
      success: true,
      message: pending
        ? `Plot ${plot.name} booked for ${client.fullName} — pending until the cheque clears and you approve it.`
        : `Plot ${plot.name} booked for ${client.fullName}.`,
      data: { _id: booking._id, code: booking.code, receiptPaymentId: paidId }
    });
  } catch (error) {
    next(error);
  }
};

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

exports.listBookings = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['code', 'associateCode']) };
    if (Object.values(BOOKING_STATUSES).includes(req.query.status)) filter.status = req.query.status;
    for (const key of ['project', 'associate', 'client', 'plot']) {
      if (req.query[key]) {
        assertId(req.query[key], key);
        filter[key] = req.query[key];
      }
    }
    const [rows, total] = await Promise.all([
      Booking.find(filter)
        .populate('plot', 'code name')
        .populate('project', 'code name')
        .populate('client', 'code fullName mobile')
        .populate('associate', 'memberCode fullName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(filter)
    ]);
    return listResponse(res, { rows, total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.getBooking = async (req, res, next) => {
  try {
    assertId(req.params.id, 'booking');
    const booking = await Booking.findById(req.params.id)
      .populate({ path: 'plot', populate: { path: 'block', select: 'code name' } })
      .populate('project', 'code name')
      .populate('client')
      .populate('associate', 'memberCode fullName phone email')
      .lean();
    if (!booking) throw httpError('Booking not found.', 404);
    const [schedule, receipts, allotment] = await Promise.all([
      PlotPayment.find({ booking: booking._id }).sort({ seq: 1, revision: 1 }).lean(),
      PlotReceipt.find({ booking: booking._id }).sort({ paidOn: 1, createdAt: 1 }).lean(),
      allotmentOf({ ...booking, project: booking.project?._id })
    ]);
    const today = startOfDay();
    const rows = schedule.map((p) => withDueState(p, today));
    const open = rows.filter((p) => OPEN_INSTALMENT_STATUSES.includes(p.status));
    const cutoff = endOfToday();
    res.status(200).json({
      success: true,
      data: {
        ...booking,
        allotment,
        schedule: rows,
        receipts,
        balance: round2(booking.price - booking.paidTotal),
        dueNow: round2(open.filter((p) => new Date(p.dueDate) <= cutoff).reduce((s, p) => s + p.remaining, 0)),
        nextDue: open[0] || null
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve a PENDING booking once its cheque has cleared: it becomes active and
 * the held cheque is received as an ordinary first payment (receipt dated the
 * cheque date). Commission on it runs after commit, as for any payment.
 * A bounced cheque is handled by cancelling instead.
 */
exports.approveBooking = async (req, res, next) => {
  try {
    assertId(req.params.id, 'booking');

    const { booking, receipt } = await withTransaction(async (session) => {
      const current = await Booking.findById(req.params.id).session(session);
      if (!current) throw httpError('Booking not found.', 404);
      if (current.status !== BOOKING_STATUSES.PENDING) throw httpError('Only a pending booking can be approved.', 409);

      current.status = BOOKING_STATUSES.ACTIVE;
      current.approval = { at: new Date(), by: req.user._id };
      await current.save({ session });

      const held = current.pendingPayment;
      const paid = held
        ? await receiptService.recordPayment(
            {
              bookingId: current._id,
              amount: held.amount,
              paidOn: held.paidOn,
              mode: held.mode || null,
              reference: held.reference,
              ratingPct: held.ratingPct,
              adjustment: PAYMENT_ADJUSTMENTS.PAY_AHEAD,
              actor: req.user
            },
            session
          )
        : null;
      return { booking: current, receipt: paid };
    });

    if (receipt) await settlePayment(receipt._id);

    await record(req, {
      action: PLOT_ACTIONS.BOOKING_APPROVED,
      targetType: 'PlotBooking',
      target: booking._id,
      targetCode: booking.code,
      after: { receipt: receipt?.receiptNo ?? null, amount: receipt?.amount ?? 0 }
    });

    res.status(200).json({
      success: true,
      message: receipt
        ? `Booking ${booking.code} approved — receipt ${receipt.receiptNo}.`
        : `Booking ${booking.code} approved.`,
      data: { receiptPaymentId: receipt?._id ?? null }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cancel: the plot goes back on sale, unpaid instalments are closed, the
 * refund the admin gave is recorded, and every commission the booking earned
 * is reversed (after commit, see plotCommissionService.reverseBooking).
 */
exports.cancelBooking = async (req, res, next) => {
  try {
    assertId(req.params.id, 'booking');
    const reason = str(req.body.reason);
    if (!reason) throw httpError('A reason for cancelling is required.');
    const refundAmount = round2(numberOr(req.body.refundAmount, 0));
    if (!(refundAmount >= 0)) throw httpError('Refund cannot be negative.');
    if (req.body.refundMode && !PAYMENT_MODES.includes(req.body.refundMode)) throw httpError('Unknown refund mode.');

    const booking = await withTransaction(async (session) => {
      const current = await Booking.findById(req.params.id).session(session);
      if (!current) throw httpError('Booking not found.', 404);
      if (current.status === BOOKING_STATUSES.CANCELLED) throw httpError('This booking is already cancelled.', 409);
      if (refundAmount > current.paidTotal) {
        throw httpError(`Refund cannot be more than the ₹${current.paidTotal} paid.`);
      }

      current.status = BOOKING_STATUSES.CANCELLED;
      current.cancel = {
        at: new Date(),
        by: req.user._id,
        reason,
        refundAmount,
        refundMode: req.body.refundMode || '',
        refundReference: str(req.body.refundReference)
      };
      await current.save({ session });

      await PlotPayment.updateMany(
        { booking: current._id, status: { $in: OPEN_INSTALMENT_STATUSES } },
        { $set: { status: INSTALMENT_STATUSES.CANCELLED } },
        { session }
      );
      await Plot.updateOne(
        { _id: current.plot, currentBooking: current._id },
        { $set: { status: PLOT_STATUSES.AVAILABLE, currentBooking: null } },
        { session }
      );
      return current;
    });

    const { reversed } = await reverseBooking(booking._id, `Booking ${booking.code} cancelled: ${reason}`).catch((err) => {
      console.error(`[plot-commission] reversing ${booking.code} failed; reconcile:plots will retry.`, err.message);
      return { reversed: 0 };
    });

    await record(req, {
      action: PLOT_ACTIONS.BOOKING_CANCELLED,
      targetType: 'PlotBooking',
      target: booking._id,
      targetCode: booking.code,
      after: { refundAmount, reversedRows: reversed },
      note: reason
    });

    res.status(200).json({ success: true, message: `Booking ${booking.code} cancelled.`, data: { reversed } });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// Payments
// ===========================================================================

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

/**
 * What is due up to a date (default today), oldest first, each flagged when
 * already overdue. Only active bookings — a cancelled booking's rows are closed.
 */
exports.listDues = async (req, res, next) => {
  try {
    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
    if (Number.isNaN(asOf.getTime())) throw httpError('Invalid date.');
    asOf.setHours(23, 59, 59, 999);

    const filter = { status: { $in: OPEN_INSTALMENT_STATUSES }, dueDate: { $lte: asOf }, booking: await notPending() };
    if (req.query.project) {
      assertId(req.query.project, 'project');
      filter.project = oid(req.query.project);
    }
    if (req.query.overdue === 'true') filter.dueDate = { $lt: startOfDay() };

    const { page, limit, skip } = pageOf(req.query);
    const [rows, total, sums] = await Promise.all([
      salePopulate(PlotPayment.find(filter)).sort({ dueDate: 1 }).skip(skip).limit(limit).lean(),
      PlotPayment.countDocuments(filter),
      PlotPayment.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            due: { $sum: { $subtract: ['$dueAmount', '$paidAmount'] } },
            overdue: { $sum: { $cond: [{ $lt: ['$dueDate', startOfDay()] }, { $subtract: ['$dueAmount', '$paidAmount'] }, 0] } },
            overdueCount: { $sum: { $cond: [{ $lt: ['$dueDate', startOfDay()] }, 1, 0] } }
          }
        }
      ])
    ]);
    const today = startOfDay();
    return listResponse(res, {
      rows: rows.map((p) => withDueState(p, today)),
      total,
      page,
      limit,
      extra: {
        summary: {
          due: round2(sums[0]?.due || 0),
          overdue: round2(sums[0]?.overdue || 0),
          overdueCount: sums[0]?.overdueCount || 0
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

const EMI_VIEWS = ['pending', 'overdue', 'upcoming', 'paid', 'all'];
const ONE_DAY = 86400000;

/**
 * Plot Sales → EMIs: every EMI instalment, sliced by where it stands today.
 *
 *   pending  — unpaid or part-paid, due today or earlier (overdue included)
 *   overdue  — pending, due before today
 *   upcoming — unpaid, due after today (optionally only the next `within` days)
 *   paid     — settled
 *
 * The tab counts and totals come from one aggregate over the same base filter,
 * so they always agree with what each tab lists. Superseded and cancelled rows
 * are never EMIs anyone owes, so they are excluded outright.
 */
exports.listEmis = async (req, res, next) => {
  try {
    const view = EMI_VIEWS.includes(req.query.view) ? req.query.view : 'pending';
    const today = startOfDay();
    const endToday = endOfToday();
    const within = Math.min(Math.max(parseInt(req.query.within, 10) || 0, 0), 3650);
    const windowEnd = within ? new Date(endToday.getTime() + within * ONE_DAY) : null;

    const base = {
      kind: INSTALMENT_KINDS.EMI,
      status: { $in: [...OPEN_INSTALMENT_STATUSES, INSTALMENT_STATUSES.PAID] },
      booking: await notPending()
    };
    if (req.query.project) {
      assertId(req.query.project, 'project');
      base.project = oid(req.query.project);
    }
    if (req.query.from || req.query.to) {
      base.dueDate = {};
      if (req.query.from) base.dueDate.$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        base.dueDate.$lte = to;
      }
    }
    const search = str(req.query.search);
    if (search) {
      const [clients, bookings] = await Promise.all([
        Client.find(searchFilter(search, ['fullName', 'mobile', 'code'])).select('_id').limit(200).lean(),
        Booking.find(searchFilter(search, ['code'])).select('_id').limit(200).lean()
      ]);
      base.$or = [{ client: { $in: clients.map((c) => c._id) } }, { booking: { $in: bookings.map((b) => b._id) } }];
    }

    // The same four slices as Mongo filters (for the list). They sit beside
    // `base` in an $and, so a user-chosen date range narrows them further.
    const open = { status: { $in: OPEN_INSTALMENT_STATUSES } };
    const slice = {
      pending: { ...open, dueDate: { $lte: endToday } },
      overdue: { ...open, dueDate: { $lt: today } },
      upcoming: { ...open, dueDate: { $gt: endToday, ...(windowEnd ? { $lte: windowEnd } : {}) } },
      paid: { status: INSTALMENT_STATUSES.PAID },
      all: {}
    };
    const filter = view === 'all' ? base : { $and: [base, slice[view]] };

    // ... and as expressions (for the counts), kept next to each other on purpose.
    const isOpen = { $in: ['$status', OPEN_INSTALMENT_STATUSES] };
    const left = { $subtract: ['$dueAmount', '$paidAmount'] };
    const inPending = { $and: [isOpen, { $lte: ['$dueDate', endToday] }] };
    const inOverdue = { $and: [isOpen, { $lt: ['$dueDate', today] }] };
    const inUpcoming = {
      $and: [isOpen, { $gt: ['$dueDate', endToday] }, ...(windowEnd ? [{ $lte: ['$dueDate', windowEnd] }] : [])]
    };
    const inPaid = { $eq: ['$status', INSTALMENT_STATUSES.PAID] };
    const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
    const amount = (cond, value) => ({ $sum: { $cond: [cond, value, 0] } });

    const { page, limit, skip } = pageOf(req.query);
    const sort = view === 'paid' ? { lastPaidOn: -1, dueDate: -1 } : view === 'all' ? { dueDate: 1, seq: 1 } : { dueDate: 1 };
    const [rows, total, sums] = await Promise.all([
      PlotPayment.find(filter)
        .populate('booking', 'code plan status tenureMonths')
        .populate('plot', 'code name')
        .populate('project', 'code name')
        .populate('client', 'code fullName mobile')
        .populate('associate', 'memberCode fullName')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      PlotPayment.countDocuments(filter),
      PlotPayment.aggregate([
        { $match: base },
        {
          $group: {
            _id: null,
            all: { $sum: 1 },
            pending: count(inPending),
            overdue: count(inOverdue),
            upcoming: count(inUpcoming),
            paid: count(inPaid),
            pendingAmount: amount(inPending, left),
            overdueAmount: amount(inOverdue, left),
            upcomingAmount: amount(inUpcoming, left),
            paidAmount: amount(inPaid, '$paidAmount')
          }
        }
      ])
    ]);
    const s = sums[0] || {};
    return listResponse(res, {
      rows: rows.map((p) => withDueState(p, today)),
      total,
      page,
      limit,
      extra: {
        summary: {
          counts: {
            pending: s.pending || 0,
            overdue: s.overdue || 0,
            upcoming: s.upcoming || 0,
            paid: s.paid || 0,
            all: s.all || 0
          },
          amounts: {
            pending: round2(s.pendingAmount || 0),
            overdue: round2(s.overdueAmount || 0),
            upcoming: round2(s.upcomingAmount || 0),
            paid: round2(s.paidAmount || 0)
          }
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

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
