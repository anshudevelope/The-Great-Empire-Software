const mongoose = require('mongoose');
const Company = require('../../models/plots/Company');
const Project = require('../../models/plots/Project');
const Block = require('../../models/plots/Block');
const Plot = require('../../models/plots/Plot');
const Booking = require('../../models/plots/Booking');
const { record } = require('../../services/auditService');
const { withTransaction } = require('../../utils/transaction');
const {
  RECORD_STATUSES,
  PROJECT_STATUSES,
  RATE_UNITS,
  PLOT_STATUSES,
  PLOT_FACINGS,
  MAX_PLOTS_PER_CALL,
  publicPlotConfig
} = require('../../config/plotConfig');
const {
  round2,
  httpError,
  assertId,
  pageOf,
  listResponse,
  searchFilter,
  nextCode,
  reserveCodes,
  numberOr,
  listOf,
  slugify,
  PLOT_ACTIONS
} = require('../../services/plots/helpers');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const media = (v) => ({ url: str(typeof v === 'string' ? v : v?.url), publicId: null });
const dateOr = (v) => (v ? new Date(v) : null);

// ===========================================================================
// Config — what the frontend needs from plotConfig.
// ===========================================================================
exports.getConfig = (req, res) => res.status(200).json({ success: true, data: publicPlotConfig() });

// ===========================================================================
// Companies
// ===========================================================================
const companyFields = (body) => {
  const data = {
    name: str(body.name),
    address: str(body.address),
    contactNumber: str(body.contactNumber),
    country: str(body.country) || 'India',
    state: str(body.state),
    city: str(body.city),
    pinCode: str(body.pinCode),
    logo: media(body.logo)
  };
  for (const key of ['name', 'address', 'contactNumber', 'state', 'city', 'pinCode']) {
    if (!data[key]) throw httpError('Name, address, contact number, state, city and pin code are required.');
  }
  if (body.status && Object.values(RECORD_STATUSES).includes(body.status)) data.status = body.status;
  return data;
};

exports.listCompanies = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['code', 'name', 'contactNumber']) };
    if (req.query.status) filter.status = req.query.status;
    const [rows, total] = await Promise.all([
      Company.find(filter).sort({ code: 1 }).skip(skip).limit(limit).lean(),
      Company.countDocuments(filter)
    ]);
    return listResponse(res, { rows, total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.getCompany = async (req, res, next) => {
  try {
    assertId(req.params.id, 'company');
    const company = await Company.findById(req.params.id).lean();
    if (!company) throw httpError('Company not found.', 404);
    res.status(200).json({ success: true, data: company });
  } catch (error) {
    next(error);
  }
};

exports.createCompany = async (req, res, next) => {
  try {
    const company = await Company.create({ ...companyFields(req.body), code: await nextCode('company') });
    await record(req, { action: PLOT_ACTIONS.COMPANY_SAVED, targetType: 'PropertyCompany', target: company._id, targetCode: company.code, after: { name: company.name } });
    res.status(201).json({ success: true, message: 'Company created.', data: company });
  } catch (error) {
    next(error);
  }
};

exports.updateCompany = async (req, res, next) => {
  try {
    assertId(req.params.id, 'company');
    const company = await Company.findByIdAndUpdate(req.params.id, companyFields(req.body), {
      returnDocument: 'after',
      runValidators: true
    });
    if (!company) throw httpError('Company not found.', 404);
    await record(req, { action: PLOT_ACTIONS.COMPANY_SAVED, targetType: 'PropertyCompany', target: company._id, targetCode: company.code });
    res.status(200).json({ success: true, message: 'Company updated.', data: company });
  } catch (error) {
    next(error);
  }
};

exports.deleteCompany = async (req, res, next) => {
  try {
    assertId(req.params.id, 'company');
    if (await Project.exists({ company: req.params.id })) {
      throw httpError('This company has projects. Delete or move them first, or mark the company inactive.', 409);
    }
    const company = await Company.findByIdAndDelete(req.params.id);
    if (!company) throw httpError('Company not found.', 404);
    res.status(200).json({ success: true, message: 'Company deleted.' });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// Projects
// ===========================================================================
const projectFields = async (body) => {
  const name = str(body.name);
  if (!name) throw httpError('Project name is required.');
  assertId(body.company, 'company');
  if (!(await Company.exists({ _id: body.company }))) throw httpError('Company not found.', 404);

  const allotmentPct = numberOr(body.allotmentPct, 0);
  if (!(allotmentPct >= 0 && allotmentPct <= 100)) throw httpError('Allotment % must be between 0 and 100.');

  const location = body.location || {};
  const marketing = body.marketing || {};
  const legal = body.legal || {};
  const m = body.media || {};
  const lat = numberOr(location.lat, null);
  const lng = numberOr(location.lng, null);
  if (Number.isNaN(lat) || Number.isNaN(lng)) throw httpError('Latitude and longitude must be numbers.');

  return {
    company: body.company,
    name,
    projectStatus: Object.values(PROJECT_STATUSES).includes(body.projectStatus) ? body.projectStatus : PROJECT_STATUSES.ONGOING,
    launchDate: dateOr(body.launchDate),
    possessionDate: dateOr(body.possessionDate),
    allotmentPct,
    visible: body.visible !== false && body.visible !== 'false',
    ...(Object.values(RECORD_STATUSES).includes(body.status) ? { status: body.status } : {}),
    location: {
      address: str(location.address),
      city: str(location.city),
      state: str(location.state),
      pinCode: str(location.pinCode),
      mapsUrl: str(location.mapsUrl),
      lat,
      lng,
      landmarks: listOf(location.landmarks)
    },
    marketing: {
      shortDescription: str(marketing.shortDescription),
      description: typeof marketing.description === 'string' ? marketing.description : '',
      amenities: listOf(marketing.amenities),
      highlights: listOf(marketing.highlights)
    },
    legal: {
      reraNumber: str(legal.reraNumber),
      approvals: (Array.isArray(legal.approvals) ? legal.approvals : [])
        .map((a) => ({ authority: str(a?.authority), number: str(a?.number) }))
        .filter((a) => a.authority || a.number),
      registryDetails: typeof legal.registryDetails === 'string' ? legal.registryDetails : ''
    },
    media: {
      cover: media(m.cover),
      layoutMap: media(m.layoutMap),
      brochure: media(m.brochure),
      gallery: (Array.isArray(m.gallery) ? m.gallery : []).map(media).filter((g) => g.url),
      videoUrl: str(m.videoUrl)
    }
  };
};

// A slug no other project uses: "lalita-vihar", then "lalita-vihar-2", …
const uniqueSlug = async (name, excludeId = null) => {
  const base = slugify(name);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const clash = await Project.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
    if (!clash) return slug;
  }
};

exports.listProjects = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['code', 'name']) };
    if (req.query.company) filter.company = req.query.company;
    if (req.query.status) filter.status = req.query.status;
    const [rows, total] = await Promise.all([
      Project.find(filter).populate('company', 'code name').sort({ code: 1 }).skip(skip).limit(limit).lean(),
      Project.countDocuments(filter)
    ]);
    return listResponse(res, { rows, total, page, limit });
  } catch (error) {
    next(error);
  }
};

exports.getProject = async (req, res, next) => {
  try {
    assertId(req.params.id, 'project');
    const project = await Project.findById(req.params.id).populate('company', 'code name').lean();
    if (!project) throw httpError('Project not found.', 404);
    res.status(200).json({ success: true, data: project });
  } catch (error) {
    next(error);
  }
};

exports.createProject = async (req, res, next) => {
  try {
    const data = await projectFields(req.body);
    const project = await Project.create({ ...data, code: await nextCode('project'), slug: await uniqueSlug(data.name) });
    await record(req, { action: PLOT_ACTIONS.PROJECT_SAVED, targetType: 'PropertyProject', target: project._id, targetCode: project.code, after: { name: project.name } });
    res.status(201).json({ success: true, message: 'Project created.', data: project });
  } catch (error) {
    next(error);
  }
};

exports.updateProject = async (req, res, next) => {
  try {
    assertId(req.params.id, 'project');
    const existing = await Project.findById(req.params.id);
    if (!existing) throw httpError('Project not found.', 404);
    const data = await projectFields(req.body);
    if (data.name !== existing.name) data.slug = await uniqueSlug(data.name, existing._id);
    existing.set(data);
    await existing.save();
    await record(req, { action: PLOT_ACTIONS.PROJECT_SAVED, targetType: 'PropertyProject', target: existing._id, targetCode: existing.code });
    res.status(200).json({ success: true, message: 'Project updated.', data: existing });
  } catch (error) {
    next(error);
  }
};

exports.deleteProject = async (req, res, next) => {
  try {
    assertId(req.params.id, 'project');
    if (await Block.exists({ project: req.params.id })) {
      throw httpError('This project has blocks. Delete them first, or mark the project inactive.', 409);
    }
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) throw httpError('Project not found.', 404);
    res.status(200).json({ success: true, message: 'Project deleted.' });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// Blocks — creating one generates its plots in the same transaction.
// ===========================================================================
const plotDocs = (block, codes, fromSerial) =>
  codes.map((code, i) => {
    const serial = fromSerial + i;
    const size = round2(block.plotWidth * block.plotLength);
    const basePrice = Plot.priceOf({ size, rate: block.rate, rateUnit: block.rateUnit });
    return {
      code,
      name: `${block.name}-${serial}`,
      serial,
      block: block._id,
      project: block.project,
      company: block.company,
      width: block.plotWidth,
      length: block.plotLength,
      size,
      rate: block.rate,
      rateUnit: block.rateUnit,
      basePrice,
      totalPrice: basePrice
    };
  });

const plotCountOf = (value) => {
  const n = numberOr(value, NaN);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PLOTS_PER_CALL) {
    throw httpError(`Number of plots must be a whole number from 1 to ${MAX_PLOTS_PER_CALL}.`);
  }
  return n;
};

// Booked / hold / available per block, counted from the plots themselves.
const countsFor = async (blockIds) => {
  const rows = await Plot.aggregate([
    { $match: { block: { $in: blockIds } } },
    { $group: { _id: { block: '$block', status: '$status' }, n: { $sum: 1 } } }
  ]);
  const out = new Map();
  for (const r of rows) {
    const key = String(r._id.block);
    if (!out.has(key)) out.set(key, { total: 0, available: 0, hold: 0, booked: 0 });
    out.get(key)[r._id.status] = r.n;
    out.get(key).total += r.n;
  }
  return out;
};

exports.listBlocks = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    const filter = { ...searchFilter(req.query.search, ['code', 'name']) };
    if (req.query.project) filter.project = req.query.project;
    const [rows, total] = await Promise.all([
      Block.find(filter).populate('project', 'code name').sort({ code: 1 }).skip(skip).limit(limit).lean(),
      Block.countDocuments(filter)
    ]);
    const counts = await countsFor(rows.map((b) => b._id));
    const empty = { total: 0, available: 0, hold: 0, booked: 0 };
    return listResponse(res, {
      rows: rows.map((b) => ({ ...b, counts: counts.get(String(b._id)) || empty })),
      total,
      page,
      limit
    });
  } catch (error) {
    next(error);
  }
};

exports.getBlock = async (req, res, next) => {
  try {
    assertId(req.params.id, 'block');
    const block = await Block.findById(req.params.id).populate('project', 'code name').lean();
    if (!block) throw httpError('Block not found.', 404);
    const counts = (await countsFor([block._id])).get(String(block._id)) || { total: 0, available: 0, hold: 0, booked: 0 };
    res.status(200).json({ success: true, data: { ...block, counts } });
  } catch (error) {
    next(error);
  }
};

exports.createBlock = async (req, res, next) => {
  try {
    const { project: projectId } = req.body;
    assertId(projectId, 'project');
    const project = await Project.findById(projectId).select('company').lean();
    if (!project) throw httpError('Project not found.', 404);

    const name = str(req.body.name);
    if (!name) throw httpError('Block name is required.');
    const plotWidth = numberOr(req.body.plotWidth, NaN);
    const plotLength = numberOr(req.body.plotLength, NaN);
    const rate = numberOr(req.body.rate, NaN);
    if (!(plotWidth > 0) || !(plotLength > 0)) throw httpError('Plot width and length must be more than 0.');
    if (!(rate >= 0)) throw httpError('Rate must be 0 or more.');
    const rateUnit = req.body.rateUnit;
    if (!Object.values(RATE_UNITS).includes(rateUnit)) throw httpError('Choose the rate unit: per sq.ft or per plot.');
    const plotCount = plotCountOf(req.body.plotCount);
    const startSerial = numberOr(req.body.startSerial, 1);
    if (!Number.isInteger(startSerial) || startSerial < 1) throw httpError('Starting serial must be a whole number from 1.');

    if (await Block.exists({ project: projectId, name })) throw httpError(`Block "${name}" already exists in this project.`, 409);

    const plotSize = round2(plotWidth * plotLength);
    const plotCost = Plot.priceOf({ size: plotSize, rate, rateUnit });

    const block = await withTransaction(async (session) => {
      const [created] = await Block.create(
        [
          {
            code: await nextCode('block', session),
            project: projectId,
            company: project.company,
            name,
            plotWidth,
            plotLength,
            plotSize,
            rate,
            rateUnit,
            plotCost,
            plotCount,
            startSerial,
            nextSerial: startSerial + plotCount,
            remark: str(req.body.remark)
          }
        ],
        { session }
      );
      const codes = await reserveCodes('plot', plotCount, session);
      await Plot.insertMany(plotDocs(created, codes, startSerial), { session });
      return created;
    });

    await record(req, {
      action: PLOT_ACTIONS.BLOCK_CREATED,
      targetType: 'PropertyBlock',
      target: block._id,
      targetCode: block.code,
      after: { name: block.name, plotCount, plotCost }
    });
    res.status(201).json({ success: true, message: `Block created with ${plotCount} plots.`, data: block });
  } catch (error) {
    next(error);
  }
};

// Only the name, remark and status — geometry and price are frozen once plots
// copy them. A plot's price is changed on the plot.
exports.updateBlock = async (req, res, next) => {
  try {
    assertId(req.params.id, 'block');
    const block = await Block.findById(req.params.id);
    if (!block) throw httpError('Block not found.', 404);
    const name = str(req.body.name) || block.name;
    if (name !== block.name && (await Block.exists({ project: block.project, name, _id: { $ne: block._id } }))) {
      throw httpError(`Block "${name}" already exists in this project.`, 409);
    }
    block.name = name;
    if (req.body.remark !== undefined) block.remark = str(req.body.remark);
    if (Object.values(RECORD_STATUSES).includes(req.body.status)) block.status = req.body.status;
    await block.save();
    res.status(200).json({ success: true, message: 'Block updated.', data: block });
  } catch (error) {
    next(error);
  }
};

exports.addPlots = async (req, res, next) => {
  try {
    assertId(req.params.id, 'block');
    const count = plotCountOf(req.body.count);
    const result = await withTransaction(async (session) => {
      // Claim the serial range atomically so two "add" clicks can't overlap.
      const block = await Block.findByIdAndUpdate(
        req.params.id,
        { $inc: { nextSerial: count, plotCount: count } },
        { session, returnDocument: 'before' }
      );
      if (!block) throw httpError('Block not found.', 404);
      const codes = await reserveCodes('plot', count, session);
      await Plot.insertMany(plotDocs(block, codes, block.nextSerial), { session });
      return block;
    });
    await record(req, { action: PLOT_ACTIONS.BLOCK_PLOTS_ADDED, targetType: 'PropertyBlock', target: result._id, targetCode: result.code, after: { added: count } });
    res.status(201).json({ success: true, message: `${count} plots added.` });
  } catch (error) {
    next(error);
  }
};

exports.deleteBlock = async (req, res, next) => {
  try {
    assertId(req.params.id, 'block');
    const block = await Block.findById(req.params.id);
    if (!block) throw httpError('Block not found.', 404);
    const plotIds = await Plot.find({ block: block._id }).distinct('_id');
    const inUse =
      (await Plot.exists({ block: block._id, status: { $ne: PLOT_STATUSES.AVAILABLE } })) ||
      (await Booking.exists({ plot: { $in: plotIds } }));
    if (inUse) throw httpError('Some plots in this block are held, booked or were sold before. Mark the block inactive instead.', 409);

    await withTransaction(async (session) => {
      await Plot.deleteMany({ block: block._id }, { session });
      await Block.deleteOne({ _id: block._id }, { session });
    });
    await record(req, { action: PLOT_ACTIONS.BLOCK_DELETED, targetType: 'PropertyBlock', target: block._id, targetCode: block.code });
    res.status(200).json({ success: true, message: 'Block and its plots deleted.' });
  } catch (error) {
    next(error);
  }
};

// ===========================================================================
// Plots
// ===========================================================================
exports.listPlots = async (req, res, next) => {
  try {
    const { page, limit, skip } = pageOf(req.query);
    // Everything except status: the tab counts are computed over this, so
    // each tab shows its own number whichever one is selected.
    const base = { ...searchFilter(req.query.search, ['code', 'name']) };
    if (req.query.project) {
      assertId(req.query.project, 'project');
      base.project = new mongoose.Types.ObjectId(String(req.query.project));
    }
    if (req.query.block) {
      assertId(req.query.block, 'block');
      base.block = new mongoose.Types.ObjectId(String(req.query.block));
    }
    if (req.query.facing) base.facing = req.query.facing;

    const filter = { ...base };
    if (Object.values(PLOT_STATUSES).includes(req.query.status)) filter.status = req.query.status;
    if (req.query.sellable === 'true') {
      filter.status = { $in: [PLOT_STATUSES.AVAILABLE, PLOT_STATUSES.HOLD] };
      filter.recordStatus = RECORD_STATUSES.ACTIVE;
    }

    const [rows, total, summary] = await Promise.all([
      Plot.find(filter)
        .populate('block', 'code name')
        .populate('project', 'code name')
        .populate({ path: 'currentBooking', select: 'code client bookedOn', populate: { path: 'client', select: 'code fullName mobile' } })
        .sort({ project: 1, block: 1, serial: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Plot.countDocuments(filter),
      Plot.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);

    return listResponse(res, {
      rows,
      total,
      page,
      limit,
      extra: { summary: Object.fromEntries(summary.map((s) => [s._id, s.n])) }
    });
  } catch (error) {
    next(error);
  }
};

exports.getPlot = async (req, res, next) => {
  try {
    assertId(req.params.id, 'plot');
    const plot = await Plot.findById(req.params.id)
      .populate('block', 'code name')
      .populate('project', 'code name')
      .populate('company', 'code name')
      .populate({ path: 'currentBooking', select: 'code client associateCode bookedOn status', populate: { path: 'client', select: 'code fullName mobile' } })
      .lean();
    if (!plot) throw httpError('Plot not found.', 404);
    res.status(200).json({ success: true, data: plot });
  } catch (error) {
    next(error);
  }
};

/**
 * Name, facing, remark, active/inactive — any time. Size, rate and premium only
 * while the plot is available: a held plot's price is what was quoted, a
 * booked one's is frozen on its booking.
 */
exports.updatePlot = async (req, res, next) => {
  try {
    assertId(req.params.id, 'plot');
    const plot = await Plot.findById(req.params.id);
    if (!plot) throw httpError('Plot not found.', 404);
    const before = { totalPrice: plot.totalPrice, extraPct: plot.extraPct, extraAmount: plot.extraAmount };

    if (req.body.name !== undefined) {
      if (!str(req.body.name)) throw httpError('Plot name cannot be empty.');
      plot.name = str(req.body.name);
    }
    if (req.body.facing !== undefined) {
      if (req.body.facing && !PLOT_FACINGS.includes(req.body.facing)) throw httpError('Unknown plot facing.');
      plot.facing = req.body.facing || '';
    }
    if (req.body.remark !== undefined) plot.remark = str(req.body.remark);
    if (Object.values(RECORD_STATUSES).includes(req.body.recordStatus)) {
      if (req.body.recordStatus === RECORD_STATUSES.INACTIVE && plot.status !== PLOT_STATUSES.AVAILABLE) {
        throw httpError('Only an available plot can be made inactive.', 409);
      }
      plot.recordStatus = req.body.recordStatus;
    }

    const priceKeys = ['width', 'length', 'rate', 'rateUnit', 'extraPct', 'extraAmount'];
    const touchesPrice = priceKeys.some((k) => req.body[k] !== undefined && String(req.body[k]) !== String(plot[k]));
    if (touchesPrice) {
      if (plot.status !== PLOT_STATUSES.AVAILABLE) throw httpError('Price can only change while the plot is available.', 409);
      for (const k of ['width', 'length', 'rate', 'extraPct', 'extraAmount']) {
        if (req.body[k] === undefined) continue;
        const n = numberOr(req.body[k], 0);
        if (!(n >= 0)) throw httpError(`${k} must be 0 or more.`);
        plot[k] = n;
      }
      if (req.body.rateUnit !== undefined) {
        if (!Object.values(RATE_UNITS).includes(req.body.rateUnit)) throw httpError('Unknown rate unit.');
        plot.rateUnit = req.body.rateUnit;
      }
    }

    await plot.save();
    await record(req, {
      action: PLOT_ACTIONS.PLOT_UPDATED,
      targetType: 'PropertyPlot',
      target: plot._id,
      targetCode: plot.code,
      before,
      after: { totalPrice: plot.totalPrice, extraPct: plot.extraPct, extraAmount: plot.extraAmount }
    });
    res.status(200).json({ success: true, message: 'Plot updated.', data: plot });
  } catch (error) {
    next(error);
  }
};

exports.holdPlot = async (req, res, next) => {
  try {
    assertId(req.params.id, 'plot');
    const note = str(req.body.note);
    if (!note) throw httpError('Say who or why the plot is being held.');
    const plot = await Plot.findOneAndUpdate(
      { _id: req.params.id, status: PLOT_STATUSES.AVAILABLE, recordStatus: RECORD_STATUSES.ACTIVE },
      { $set: { status: PLOT_STATUSES.HOLD, hold: { note, at: new Date(), by: req.user._id } } },
      { returnDocument: 'after' }
    );
    if (!plot) throw httpError('Only an available, active plot can be held.', 409);
    await record(req, { action: PLOT_ACTIONS.PLOT_HELD, targetType: 'PropertyPlot', target: plot._id, targetCode: plot.code, note });
    res.status(200).json({ success: true, message: `${plot.name} is on hold.`, data: plot });
  } catch (error) {
    next(error);
  }
};

exports.unholdPlot = async (req, res, next) => {
  try {
    assertId(req.params.id, 'plot');
    const plot = await Plot.findOneAndUpdate(
      { _id: req.params.id, status: PLOT_STATUSES.HOLD },
      { $set: { status: PLOT_STATUSES.AVAILABLE, hold: { note: '', at: null, by: null } } },
      { returnDocument: 'after' }
    );
    if (!plot) throw httpError('That plot is not on hold.', 409);
    await record(req, { action: PLOT_ACTIONS.PLOT_UNHELD, targetType: 'PropertyPlot', target: plot._id, targetCode: plot.code });
    res.status(200).json({ success: true, message: `${plot.name} is available again.`, data: plot });
  } catch (error) {
    next(error);
  }
};
