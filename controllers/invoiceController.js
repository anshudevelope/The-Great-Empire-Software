const Referral = require('../models/Referral');
const { company } = require('../config/company');
const { streamCsv } = require('../utils/csv');
const { ROLES, TIER_LABELS, REFERRAL_STATUSES } = require('../config/constants');

/**
 * Invoices for money the company has received.
 *
 * Today a referral is the only kind of transaction, so every invoice is derived
 * from a Referral document. The payload is deliberately shaped around
 * "transaction" rather than "referral" so a second transaction type can be
 * added later without changing the invoice contract or the UI.
 */

const INVOICE_STATUS = {
  // The money is already collected before a referral is ever issued, so an
  // invoice is a receipt — never an outstanding demand.
  [REFERRAL_STATUSES.UNUSED]: 'Paid',
  [REFERRAL_STATUSES.USED]: 'Paid',
  [REFERRAL_STATUSES.CANCELLED]: 'Cancelled'
};

const toInvoice = (referral, billedTo) => {
  const amount = referral.amountPaid || 0;

  return {
    _id: referral._id,
    invoiceNo: referral.invoiceNo,
    invoiceDate: referral.receivedOn || referral.createdAt,
    status: INVOICE_STATUS[referral.status] || 'Paid',

    company,

    // "Received from" on the invoice: whoever referred (and paid for) the
    // member. Stays with them even if the sponsor credit was passed on.
    billedTo: {
      memberCode: referral.issuedToCode,
      name: billedTo?.fullName || referral.issuedTo?.fullName || '—',
      email: billedTo?.email || '',
      phone: billedTo?.phone || '',
      address: [billedTo?.address, billedTo?.city, billedTo?.state, billedTo?.pinCode]
        .filter(Boolean)
        .join(', ')
    },

    transaction: {
      type: 'Referral',
      referenceNo: referral.referralNo,
      issuedAt: referral.createdAt,
      // The member this payment was for. Known from the moment the referral is
      // raised, since the member is registered before it.
      forMember: referral.memberCode
        ? {
            memberCode: referral.memberCode,
            name: referral.member?.fullName || referral.memberName || null,
            placedAt: referral.usedAt,
            placedUnder: referral.placedUnderCode
          }
        : null
    },

    items: [
      {
        description: `Referral — ${referral.tier} (${TIER_LABELS[referral.tier] || ''})`,
        reference: referral.referralNo,
        quantity: 1,
        unitPrice: amount,
        amount
      }
    ],

    totals: {
      subtotal: amount,
      total: amount,
      amountPaid: referral.status === REFERRAL_STATUSES.CANCELLED ? 0 : amount,
      balance: 0
    },

    payment: {
      mode: referral.paymentMode || null,
      reference: referral.paymentRef || '',
      receivedOn: referral.receivedOn,
      // The invoice is issued in the company's name. The admin who recorded
      // the payment stays on the referral (receivedByName) for the record.
      receivedBy: company.name
    },

    cancelledAt: referral.cancelledAt,
    cancelReason: referral.cancelReason || '',
    notes: referral.notes || ''
  };
};

// Scope: admins see every invoice, an associate only those billed to them.
const scopeFor = (user) => (user.role === ROLES.ADMIN ? {} : { issuedTo: user._id });

// ---------------------------------------------------------------------------
// GET /api/invoices
// ---------------------------------------------------------------------------
exports.listInvoices = async (req, res, next) => {
  try {
    const filter = scopeFor(req.user);

    const { status, tier, search, from, to } = req.query;
    if (tier) filter.tier = tier;
    if (status === 'cancelled') filter.status = REFERRAL_STATUSES.CANCELLED;
    if (status === 'paid') filter.status = { $ne: REFERRAL_STATUSES.CANCELLED };
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: 'i' };
      filter.$or = [{ invoiceNo: rx }, { referralNo: rx }, { issuedToCode: rx }];
    }
    if (from || to) {
      filter.receivedOn = {};
      if (from) filter.receivedOn.$gte = new Date(from);
      if (to) filter.receivedOn.$lte = new Date(to);
    }

    if (req.query.format === 'csv') {
      const cursor = Referral.find(filter).sort({ receivedOn: -1, createdAt: -1 }).lean().cursor();
      return streamCsv(
        res,
        `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          { header: 'Invoice No', value: (r) => r.invoiceNo },
          { header: 'Invoice Date', value: (r) => r.receivedOn },
          { header: 'Received From', value: (r) => r.issuedToCode },
          { header: 'Transaction', value: (r) => 'Referral' },
          { header: 'Reference', value: (r) => r.referralNo },
          { header: 'Tier', value: (r) => r.tier },
          { header: 'Product', value: (r) => TIER_LABELS[r.tier] || '' },
          { header: 'Amount', value: (r) => r.amountPaid },
          { header: 'Payment Mode', value: (r) => r.paymentMode || '' },
          { header: 'Payment Ref', value: (r) => r.paymentRef || '' },
          { header: 'Received By', value: () => company.name },
          { header: 'Status', value: (r) => (r.status === 'cancelled' ? 'Cancelled' : 'Paid') }
        ],
        cursor
      );
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const [rows, total, totals] = await Promise.all([
      Referral.find(filter)
        .populate('issuedTo', 'memberCode fullName email phone address city state pinCode')
        .populate('member', 'memberCode fullName')
        .sort({ receivedOn: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Referral.countDocuments(filter),
      Referral.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            billed: { $sum: '$amountPaid' },
            cancelled: {
              $sum: { $cond: [{ $eq: ['$status', REFERRAL_STATUSES.CANCELLED] }, '$amountPaid', 0] }
            }
          }
        }
      ])
    ]);

    const sums = totals[0] || { billed: 0, cancelled: 0 };

    return res.status(200).json({
      success: true,
      count: rows.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      summary: {
        billed: sums.billed,
        cancelled: sums.cancelled,
        collected: sums.billed - sums.cancelled
      },
      data: rows.map((r) => toInvoice(r, r.issuedTo))
    });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// GET /api/invoices/:id — the full printable document.
// ---------------------------------------------------------------------------
exports.getInvoice = async (req, res, next) => {
  try {
    const referral = await Referral.findById(req.params.id)
      .populate('issuedTo', 'memberCode fullName email phone address city state pinCode')
      .populate('member', 'memberCode fullName');

    if (!referral) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const owner = referral.issuedTo?._id || referral.issuedTo;
    if (req.user.role !== ROLES.ADMIN && String(owner) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'This invoice was not issued to you.' });
    }

    return res.status(200).json({ success: true, data: toInvoice(referral, referral.issuedTo) });
  } catch (error) {
    next(error);
  }
};

// Letterhead for the print view. Same data as /api/company/full, kept here so
// the invoice screen needs only one request.
exports.getCompany = async (req, res) => {
  return res.status(200).json({ success: true, data: company });
};
