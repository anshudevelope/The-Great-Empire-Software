const mongoose = require('mongoose');
const Associate = require('../../models/Associate');
const Client = require('../../models/plots/Client');
const Plot = require('../../models/plots/Plot');
const Booking = require('../../models/plots/Booking');
const PlotPayment = require('../../models/plots/Payment');
const { record } = require('../../services/auditService');
const { withTransaction } = require('../../utils/transaction');
const { streamCsv } = require('../../utils/csv');
const { ROLES, STATUSES, TREE_STATUSES, PAYMENT_MODES } = require('../../config/constants');
const {
  RECORD_STATUSES,
  PLOT_STATUSES,
  BOOKING_STATUSES,
  INSTALMENT_STATUSES,
  PAYMENT_PLANS,
  PLOT_RATING
} = require('../../config/plotConfig');
const { buildSchedule, validatePlan } = require('../../services/plots/scheduleService');
const { settlePayment, reverseBooking } = require('../../services/plots/commissionService');
const {
  round2,
  httpError,
  assertId,
  pageOf,
  listResponse,
  searchFilter,
  nextCode,
  nextReceiptNo,
  numberOr,
  PLOT_ACTIONS
} = require('../../services/plots/helpers');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// Start of today in server time — "due" / "overdue" boundaries.
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

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

const ratingOf = (value) => {
  if (!PLOT_RATING.enabled) return 100;
  const n = numberOr(value, PLOT_RATING.defaultPct);
  if (!(n >= 0 && n <= 100)) throw httpError('Rating must be between 0 and 100.');
  return n;
};

// What the Sell form shows before submitting. Same maths the sale will use.
exports.previewSchedule = async (req, res, next) => {
  try {
    let price = numberOr(req.query.price, NaN);
    if (req.query.plot) {
      assertId(req.query.plot, 'plot');
      const plot = await Plot.findById(req.query.plot).select('totalPrice').lean();
      if (!plot) throw httpError('Plot not found.', 404);
      price = plot.totalPrice;
    }
    if (!(price >= 0)) throw httpError('Plot price is required.');
    const plan = planInput(req.query, price);
    const schedule = buildSchedule({ ...plan, price, bookedOn: bookedOnOf(req.query.bookedOn) });
    res.status(200).json({ success: true, data: { price, ...plan, ...schedule } });
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
      Plot.findById(plotId).lean(),
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

    const price = plot.totalPrice;
    const plan = planInput(req.body, price);
    const bookedOn = bookedOnOf(req.body.bookedOn);
    const { rows, emiAmount } = buildSchedule({ ...plan, price, bookedOn });

    // Optional: collect the first instalment now.
    const payNow = req.body.payNow && typeof req.body.payNow === 'object' ? req.body.payNow : null;
    if (payNow && payNow.mode && !PAYMENT_MODES.includes(payNow.mode)) throw httpError('Unknown payment mode.');
    const rating = payNow ? ratingOf(payNow.ratingPct) : null;

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
            project: plot.project,
            client: client._id,
            associate: associate._id,
            associateCode: associate.memberCode,
            ...plan,
            emiAmount,
            price,
            bookedOn,
            notes: str(req.body.notes),
            soldBy: req.user._id
          }
        ],
        { session }
      );
      await Plot.updateOne({ _id: plot._id }, { $set: { currentBooking: created._id } }, { session });

      const docs = rows.map((r) => ({
        ...r,
        booking: created._id,
        plot: plot._id,
        project: plot.project,
        client: client._id,
        associate: associate._id
      }));

      let firstPaidId = null;
      if (payNow) {
        const first = docs[0];
        Object.assign(first, {
          status: INSTALMENT_STATUSES.PAID,
          paidAmount: first.dueAmount,
          paidOn: payNow.paidOn ? new Date(payNow.paidOn) : bookedOn,
          mode: payNow.mode || null,
          reference: str(payNow.reference),
          ratingPct: rating,
          receiptNo: await nextReceiptNo(session),
          receivedBy: req.user._id,
          receivedByCode: req.user.memberCode || null
        });
        created.paidTotal = first.dueAmount;
        if (docs.length === 1) created.status = BOOKING_STATUSES.COMPLETED;
        await created.save({ session });
      }

      // create() rather than insertMany so the commissionBase hook runs.
      const inserted = await PlotPayment.create(docs, { session, ordered: true });
      if (payNow) firstPaidId = inserted[0]._id;
      return { booking: created, paidId: firstPaidId };
    });

    if (paidId) await settlePayment(paidId);

    await record(req, {
      action: PLOT_ACTIONS.BOOKING_CREATED,
      targetType: 'PlotBooking',
      target: booking._id,
      targetCode: booking.code,
      after: { plot: plot.code, client: client.code, associate: associate.memberCode, price, plan: plan.plan }
    });

    res.status(201).json({
      success: true,
      message: `Plot ${plot.name} booked for ${client.fullName}.`,
      data: { _id: booking._id, code: booking.code, receiptPaymentId: paidId }
    });
  } catch (error) {
    next(error);
  }
};

// Paid / due / overdue status for one instalment, as the UI shows it.
const withDueState = (p, today = startOfDay()) => ({
  ...p,
  overdue: p.status === INSTALMENT_STATUSES.DUE && new Date(p.dueDate) < today
});

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
    const schedule = await PlotPayment.find({ booking: booking._id }).sort({ seq: 1 }).lean();
    const today = startOfDay();
    const due = schedule.filter((p) => p.status === INSTALMENT_STATUSES.DUE);
    res.status(200).json({
      success: true,
      data: {
        ...booking,
        schedule: schedule.map((p) => withDueState(p, today)),
        balance: round2(booking.price - booking.paidTotal),
        nextDue: due[0] ? withDueState(due[0], today) : null
      }
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
        { booking: current._id, status: INSTALMENT_STATUSES.DUE },
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

/**
 * Receive one instalment, in full. Earlier instalments must be paid first so
 * the schedule is collected in order. The status flip is guarded (due → paid)
 * so a double click cannot receive the same instalment twice.
 */
exports.receivePayment = async (req, res, next) => {
  try {
    assertId(req.params.id, 'payment');
    const amount = round2(numberOr(req.body.amount, NaN));
    if (req.body.mode && !PAYMENT_MODES.includes(req.body.mode)) throw httpError('Unknown payment mode.');
    const ratingPct = ratingOf(req.body.ratingPct);
    const paidOn = req.body.paidOn ? new Date(req.body.paidOn) : new Date();
    if (Number.isNaN(paidOn.getTime())) throw httpError('Invalid payment date.');

    const payment = await withTransaction(async (session) => {
      const row = await PlotPayment.findById(req.params.id).session(session);
      if (!row) throw httpError('Instalment not found.', 404);
      if (row.status !== INSTALMENT_STATUSES.DUE) throw httpError('This instalment is not due.', 409);
      if (amount !== row.dueAmount) throw httpError(`Amount must equal the instalment due (₹${row.dueAmount}).`);

      const earlier = await PlotPayment.exists({ booking: row.booking, status: INSTALMENT_STATUSES.DUE, seq: { $lt: row.seq } }).session(session);
      if (earlier) throw httpError('Receive the earlier instalments first.', 409);

      const booking = await Booking.findById(row.booking).session(session);
      if (!booking || booking.status !== BOOKING_STATUSES.ACTIVE) throw httpError('This booking is not active.', 409);

      row.set({
        status: INSTALMENT_STATUSES.PAID,
        paidAmount: amount,
        paidOn,
        mode: req.body.mode || null,
        reference: str(req.body.reference),
        notes: typeof req.body.notes === 'string' ? req.body.notes : '',
        ratingPct,
        receiptNo: await nextReceiptNo(session, paidOn),
        receivedBy: req.user._id,
        receivedByCode: req.user.memberCode || null
      });
      await row.save({ session });

      booking.paidTotal = round2(booking.paidTotal + amount);
      const stillDue = await PlotPayment.exists({ booking: booking._id, status: INSTALMENT_STATUSES.DUE }).session(session);
      if (!stillDue) booking.status = BOOKING_STATUSES.COMPLETED;
      await booking.save({ session });
      return row;
    });

    await settlePayment(payment._id);
    await record(req, {
      action: PLOT_ACTIONS.PAYMENT_RECEIVED,
      targetType: 'PlotPayment',
      target: payment._id,
      targetCode: payment.receiptNo,
      after: { amount: payment.paidAmount, ratingPct: payment.ratingPct }
    });

    res.status(200).json({ success: true, message: `Payment received — receipt ${payment.receiptNo}.`, data: payment });
  } catch (error) {
    next(error);
  }
};

const paymentPopulate = (q) =>
  q
    .populate('booking', 'code plan status')
    .populate('plot', 'code name')
    .populate('project', 'code name')
    .populate('client', 'code fullName mobile')
    .populate('associate', 'memberCode fullName');

// Payment history: paid receipts by default; filters by date, kind, project.
exports.listPayments = async (req, res, next) => {
  try {
    const filter = { status: Object.values(INSTALMENT_STATUSES).includes(req.query.status) ? req.query.status : INSTALMENT_STATUSES.PAID };
    if (req.query.kind) filter.kind = req.query.kind;
    if (req.query.project) {
      assertId(req.query.project, 'project');
      filter.project = oid(req.query.project);
    }
    if (req.query.booking) {
      assertId(req.query.booking, 'booking');
      filter.booking = oid(req.query.booking);
    }
    const dateField = filter.status === INSTALMENT_STATUSES.PAID ? 'paidOn' : 'dueDate';
    if (req.query.from || req.query.to) {
      filter[dateField] = {};
      if (req.query.from) filter[dateField].$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter[dateField].$lte = to;
      }
    }
    if (req.query.search) Object.assign(filter, searchFilter(req.query.search, ['receiptNo', 'reference']));

    if (req.query.format === 'csv') {
      const cursor = paymentPopulate(PlotPayment.find(filter).sort({ [dateField]: -1 })).lean().cursor();
      return streamCsv(
        res,
        `plot-payments-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          { header: 'Receipt No', value: (p) => p.receiptNo || '' },
          { header: 'Paid On', value: (p) => p.paidOn },
          { header: 'Booking', value: (p) => p.booking?.code },
          { header: 'Project', value: (p) => p.project?.name },
          { header: 'Plot', value: (p) => p.plot?.name },
          { header: 'Client', value: (p) => p.client?.fullName },
          { header: 'Client Mobile', value: (p) => p.client?.mobile },
          { header: 'Associate', value: (p) => p.associate?.memberCode },
          { header: 'Type', value: (p) => p.kind },
          { header: 'Due Date', value: (p) => p.dueDate },
          { header: 'Amount', value: (p) => p.paidAmount || p.dueAmount },
          { header: 'Rating %', value: (p) => p.ratingPct },
          { header: 'Mode', value: (p) => p.mode || '' },
          { header: 'Reference', value: (p) => p.reference || '' },
          { header: 'Status', value: (p) => p.status }
        ],
        cursor
      );
    }

    const { page, limit, skip } = pageOf(req.query);
    const [rows, total, sums] = await Promise.all([
      paymentPopulate(PlotPayment.find(filter)).sort({ [dateField]: -1, seq: 1 }).skip(skip).limit(limit).lean(),
      PlotPayment.countDocuments(filter),
      PlotPayment.aggregate([
        { $match: filter },
        { $group: { _id: null, paid: { $sum: '$paidAmount' }, due: { $sum: '$dueAmount' } } }
      ])
    ]);
    return listResponse(res, {
      rows,
      total,
      page,
      limit,
      extra: { summary: { paid: round2(sums[0]?.paid || 0), due: round2(sums[0]?.due || 0) } }
    });
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

    const filter = { status: INSTALMENT_STATUSES.DUE, dueDate: { $lte: asOf } };
    if (req.query.project) {
      assertId(req.query.project, 'project');
      filter.project = oid(req.query.project);
    }
    if (req.query.overdue === 'true') filter.dueDate = { $lt: startOfDay() };

    const { page, limit, skip } = pageOf(req.query);
    const [rows, total, sums] = await Promise.all([
      paymentPopulate(PlotPayment.find(filter)).sort({ dueDate: 1 }).skip(skip).limit(limit).lean(),
      PlotPayment.countDocuments(filter),
      PlotPayment.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            due: { $sum: '$dueAmount' },
            overdue: { $sum: { $cond: [{ $lt: ['$dueDate', startOfDay()] }, '$dueAmount', 0] } },
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

// One paid instalment, with everything its printed receipt shows.
exports.getReceipt = async (req, res, next) => {
  try {
    assertId(req.params.id, 'payment');
    const payment = await PlotPayment.findById(req.params.id)
      .populate({ path: 'booking', select: 'code plan price paidTotal tenureMonths bookedOn status' })
      .populate({ path: 'plot', select: 'code name size facing block', populate: { path: 'block', select: 'name' } })
      .populate({ path: 'project', select: 'code name location company', populate: { path: 'company' } })
      .populate('client')
      .populate('associate', 'memberCode fullName')
      .lean();
    if (!payment) throw httpError('Payment not found.', 404);
    if (payment.status !== INSTALMENT_STATUSES.PAID) throw httpError('This instalment has not been paid yet.', 409);
    const totalInstalments = await PlotPayment.countDocuments({ booking: payment.booking._id });
    res.status(200).json({
      success: true,
      data: {
        ...payment,
        totalInstalments,
        balance: round2(payment.booking.price - payment.booking.paidTotal)
      }
    });
  } catch (error) {
    next(error);
  }
};
