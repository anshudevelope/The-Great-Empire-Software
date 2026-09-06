/**
 * CSV export helpers.
 *
 * Streams from a Mongo cursor rather than building an array — a large downline
 * would otherwise be materialised entirely in memory before the first byte is
 * sent.
 */

/**
 * Escape one cell.
 *
 * Two separate concerns:
 *  1. CSV syntax — quotes, commas, newlines.
 *  2. Formula injection — a cell beginning with = + - @ (or a leading tab/CR)
 *     is executed as a formula when the file is opened in Excel or Sheets. A
 *     member whose name is set to "=HYPERLINK(...)" would otherwise turn every
 *     exported report into an attack on whoever opens it. Prefixing with a
 *     single quote neutralises it while still displaying the text.
 */
const escapeCell = (value) => {
  if (value === null || value === undefined) return '';

  let str = value instanceof Date ? value.toISOString() : String(value);

  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;

  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;

  return str;
};

const toRow = (values) => values.map(escapeCell).join(',') + '\r\n';

/**
 * Stream a cursor to the response as CSV.
 *
 * @param {object}   res       Express response
 * @param {string}   filename  download filename
 * @param {Array}    columns   [{ header, value: (doc) => any }]
 * @param {object}   cursor    Mongoose query cursor
 */
const streamCsv = async (res, filename, columns, cursor) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // BOM so Excel reads UTF-8 correctly (Indian names otherwise mangle).
  res.write('﻿');
  res.write(toRow(columns.map((c) => c.header)));

  for await (const doc of cursor) {
    res.write(toRow(columns.map((c) => c.value(doc))));
  }

  res.end();
};

module.exports = { streamCsv, escapeCell, toRow };
