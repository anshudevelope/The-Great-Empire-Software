const crypto = require('crypto');

// Ambiguous glyphs removed (0/O, 1/l/I) — this password gets read off a screen
// and typed by hand, so transcription errors are a real failure mode.
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*';

const pick = (charset) => charset[crypto.randomInt(0, charset.length)];

/**
 * Random password generator (currently unused — the admin sets passwords on
 * the registration form). Uses crypto.randomInt, not Math.random: these are
 * credentials.
 */
const generateTempPassword = (length = 10) => {
  // Guarantee one of each class so the result always clears a policy check.
  const required = [pick(LETTERS.toUpperCase()), pick(LETTERS.toLowerCase()), pick(DIGITS), pick(SYMBOLS)];
  const pool = LETTERS + DIGITS + SYMBOLS;

  const chars = [...required];
  while (chars.length < length) chars.push(pick(pool));

  // Fisher-Yates, so the required characters aren't always in the same slots.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

module.exports = { generateTempPassword };
