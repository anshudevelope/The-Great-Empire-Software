const fs = require('fs');
const path = require('path');

/**
 * Company / brand details for the whole project.
 *
 * Single source of truth: data/company.json. Edit that file — not the code and
 * not .env — and every invoice, letterhead and branded surface follows.
 *
 * It lives in a data file rather than environment variables because it is
 * content, not configuration: it is long, structured (bank block, invoice
 * block), non-secret, and belongs in version control so a change to the
 * letterhead is reviewable.
 */
const DATA_FILE = path.join(__dirname, '..', 'data', 'company.json');

// Shape guarantee: every consumer can read these keys without null checks,
// even if someone trims the JSON down.
const DEFAULTS = {
  name: 'The Great Empire',
  legalName: '',
  tagline: '',
  address: '',
  city: '',
  state: '',
  pinCode: '',
  country: 'India',
  phone: '',
  altPhone: '',
  email: '',
  website: '',
  gstin: '',
  pan: '',
  cin: '',
  rera: '',
  bank: { name: '', accountName: '', accountNumber: '', ifsc: '', branch: '' },
  invoice: { footerNote: '', terms: '' }
};

const load = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...DEFAULTS,
      ...parsed,
      bank: { ...DEFAULTS.bank, ...(parsed.bank || {}) },
      invoice: { ...DEFAULTS.invoice, ...(parsed.invoice || {}) }
    };
  } catch (error) {
    // A malformed or missing file must not take the API down — fall back to
    // defaults and make the reason obvious in the log.
    console.error(`[company] could not read ${DATA_FILE}: ${error.message}. Using defaults.`);
    return { ...DEFAULTS };
  }
};

// Read once at boot. Editing the JSON needs a restart, which matches how the
// rest of the configuration behaves.
const company = load();

module.exports = { company, load, DATA_FILE };
