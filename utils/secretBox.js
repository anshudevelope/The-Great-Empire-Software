const crypto = require('crypto');

/**
 * Reversible encryption for the one value the admin must be able to read back:
 * an associate's password.
 *
 * Login never touches this — it still verifies the bcrypt hash. This copy exists
 * only so the admin panel can show the password, and it is AES-256-GCM rather
 * than plain text so a leaked database dump alone does not expose credentials.
 *
 * The key comes from PASSWORD_ENCRYPTION_KEY, falling back to JWT_SECRET so an
 * existing deployment keeps working. Changing whichever one is in use makes
 * every stored copy unreadable (logins are unaffected), so set it once.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const keyMaterial = () => {
  const secret = process.env.PASSWORD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('PASSWORD_ENCRYPTION_KEY (or JWT_SECRET) must be set to store passwords.');
  // Hashing normalises any secret length to exactly the 32 bytes AES-256 needs.
  return crypto.createHash('sha256').update(String(secret)).digest();
};

// Format: iv.authTag.ciphertext, each base64 — self-contained, no schema change
// needed if the algorithm parameters ever move.
const encrypt = (plain) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyMaterial(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
};

// Returns null rather than throwing: a record encrypted under an old key, or a
// member created before passwords were stored this way, must not 500 a listing.
const decrypt = (box) => {
  if (!box) return null;
  try {
    const [iv, tag, data] = String(box).split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv(ALGORITHM, keyMaterial(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};

module.exports = { encrypt, decrypt };
