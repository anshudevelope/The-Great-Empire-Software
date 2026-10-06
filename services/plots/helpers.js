const mongoose = require('mongoose');
const Counter = require('../../models/Counter');
const { CODES } = require('../../config/plotConfig');

// Small utilities shared by the plot module's controllers and services.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const httpError = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertId = (id, label = 'record') => {
  if (!mongoose.isValidObjectId(id)) throw httpError(`Invalid ${label} id.`, 400);
};

// page / limit from the query, with the same bounds the existing lists use.
const pageOf = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
};

const listResponse = (res, { rows, total, page, limit, extra = {} }) =>
  res.status(200).json({
    success: true,
    count: rows.length,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
    ...extra,
    data: rows
  });

// A case-insensitive "contains" over several fields, or nothing when blank.
const searchFilter = (search, fields) => {
  const q = String(search || '').trim();
  if (!q) return {};
  const rx = { $regex: escapeRegex(q), $options: 'i' };
  return { $or: fields.map((f) => ({ [f]: rx })) };
};

// ---------------------------------------------------------------------------
// Codes — from the per-business Counter, so T2's sequences are its own.
// ---------------------------------------------------------------------------
const pad = (n, width) => String(n).padStart(width, '0');

const nextCode = async (kind, session = null) => {
  const spec = CODES[kind];
  const seq = await Counter.next(spec.sequence, session);
  return `${spec.prefix}${pad(seq, spec.pad)}`;
};

/**
 * N consecutive codes in ONE counter update — generating 500 plots must not
 * cost 500 round trips, and a single $inc keeps the range contiguous even
 * when two blocks are created at once.
 */
const reserveCodes = async (kind, count, session = null) => {
  const spec = CODES[kind];
  const counter = await Counter.findByIdAndUpdate(
    spec.sequence,
    { $inc: { seq: count } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  const first = counter.seq - count + 1;
  return Array.from({ length: count }, (_, i) => `${spec.prefix}${pad(first + i, spec.pad)}`);
};

// Audit action names for the plot module (the audit log takes any string).
const PLOT_ACTIONS = {
  COMPANY_SAVED: 'plot.company_saved',
  PROJECT_SAVED: 'plot.project_saved',
  BLOCK_CREATED: 'plot.block_created',
  BLOCK_PLOTS_ADDED: 'plot.block_plots_added',
  BLOCK_DELETED: 'plot.block_deleted',
  PLOT_UPDATED: 'plot.plot_updated',
  PLOT_HELD: 'plot.plot_held',
  PLOT_UNHELD: 'plot.plot_unheld',
  CLIENT_SAVED: 'plot.client_saved',
  BOOKING_CREATED: 'plot.booking_created',
  BOOKING_CANCELLED: 'plot.booking_cancelled',
  PAYMENT_RECEIVED: 'plot.payment_received',
  PAYOUT_GENERATED: 'plot.payout_generated',
  PAYOUT_FINALIZED: 'plot.payout_finalized',
  PAYOUT_CANCELLED: 'plot.payout_cancelled',
  PAYOUT_DISCARDED: 'plot.payout_discarded'
};

// RCP-2026-000123 — restarts each year, like invoice numbers.
const nextReceiptNo = async (session = null, date = new Date()) => {
  const spec = CODES.receipt;
  const year = date.getFullYear();
  const seq = await Counter.next(`${spec.sequence}:${year}`, session);
  return `${spec.prefix}${year}-${pad(seq, spec.pad)}`;
};

// Optional numeric field from a form: '' / null / undefined → fallback.
const numberOr = (value, fallback = 0) => {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

// Comma/newline separated text or an array → trimmed, non-empty strings.
const listOf = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  return [];
};

const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project';

module.exports = {
  round2,
  httpError,
  escapeRegex,
  assertId,
  pageOf,
  listResponse,
  searchFilter,
  nextCode,
  reserveCodes,
  nextReceiptNo,
  PLOT_ACTIONS,
  numberOr,
  listOf,
  slugify
};
