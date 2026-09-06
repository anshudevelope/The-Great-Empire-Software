/**
 * Minimal in-memory rate limiter.
 *
 * Deliberately dependency-free. Note the limitation: state lives in this
 * process, so with multiple instances behind a load balancer each one keeps
 * its own counters. Swap in a Redis-backed store before scaling out.
 *
 * The per-voucher attempt lockout in the referral controller is the real
 * brute-force defence — this only blunts high-volume probing.
 */
const buckets = new Map();

// Drop stale buckets so the map can't grow without bound.
const sweep = () => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
};
const sweepTimer = setInterval(sweep, 60_000);
if (sweepTimer.unref) sweepTimer.unref(); // don't hold the process open

const rateLimit = ({ windowMs = 60_000, max = 10, message = 'Too many requests. Please try again shortly.' } = {}) =>
  (req, res, next) => {
    // Key on the authenticated user when present, falling back to IP. Keying
    // on IP alone would let one user behind a shared NAT lock out colleagues.
    const key = `${req.baseUrl}${req.path}:${req.user ? req.user._id : req.ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, message, retryAfter });
    }

    next();
  };

module.exports = { rateLimit };
