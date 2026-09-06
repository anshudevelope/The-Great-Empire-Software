const mongoose = require('mongoose');

// Thrown when a tree slot was claimed by a concurrent registration between our
// spillover resolution and our write. Signals "re-resolve and try again",
// not a real failure.
class SlotTakenError extends Error {
  constructor(message = 'Placement slot was taken concurrently.') {
    super(message);
    this.name = 'SlotTakenError';
  }
}

// Transactions need a replica set. Atlas is one; a bare local `mongod` is not.
// Rather than fail on a developer's machine, detect that specific case once and
// fall back to running without a session.
const isUnsupportedTransaction = (err) =>
  /Transaction numbers are only allowed on a replica set|does not support (sessions|transactions)|Illegal state transition/i
    .test(err?.message || '');

let transactionsSupported = null; // null = unknown, cached after first attempt

/**
 * Runs `fn(session)` inside a transaction, retrying when a concurrent write
 * beat us to the slot.
 *
 * Retries cover two cases: our own SlotTakenError, and MongoDB's
 * TransientTransactionError (raised when two transactions touch the same
 * document — exactly what two simultaneous registrations do).
 */
const withTransaction = async (fn, { maxRetries = 3 } = {}) => {
  if (transactionsSupported === false) return fn(null);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      transactionsSupported = true;
      return result;
    } catch (err) {
      if (transactionsSupported === null && isUnsupportedTransaction(err)) {
        // Standalone mongod. The conditional slot claim still prevents an
        // overwrite; only cross-document atomicity is lost.
        transactionsSupported = false;
        return fn(null);
      }

      const retryable =
        err instanceof SlotTakenError ||
        err?.errorLabels?.includes('TransientTransactionError');

      if (!retryable || attempt === maxRetries) throw err;
    } finally {
      await session.endSession().catch(() => {});
    }
  }
};

module.exports = { withTransaction, SlotTakenError, isUnsupportedTransaction };
