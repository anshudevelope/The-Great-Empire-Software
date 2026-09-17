/**
 * Reconciles the indexes in MongoDB with the ones declared in the schemas.
 *
 *   npm run sync:indexes
 *
 * Why this exists: MongoDB refuses to create a second index with the same key
 * pattern but different options. So when an index's OPTIONS change — a plain
 * index becoming unique, or gaining a partial filter — the new definition is
 * silently rejected and the old, weaker index stays in place. Nothing errors;
 * the constraint simply isn't enforced.
 *
 * syncIndexes() drops indexes that are no longer declared and builds the ones
 * that are missing, which is exactly what that situation needs.
 *
 * Run after any change to an index definition. Safe to re-run.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Associate = require('../models/Associate');
const Referral = require('../models/Referral');
const Counter = require('../models/Counter');
const CommissionLedger = require('../models/CommissionLedger');
const PayoutBatch = require('../models/PayoutBatch');
const PayoutLine = require('../models/PayoutLine');
const Setting = require('../models/Setting');

// Every model with a declared index belongs here. A model left out keeps
// whatever indexes mongoose's autoIndex happened to build at runtime — which
// races against the first write and, for a constraint that must hold before
// that write (PayoutBatch's one-draft rule, CommissionLedger's idempotency
// key), means the guarantee silently does not exist.
const MODELS = [Associate, Referral, Counter, CommissionLedger, PayoutBatch, PayoutLine, Setting];

const describe = (i) =>
  `${i.name} ${JSON.stringify(i.key)}` +
  `${i.unique ? ' unique' : ''}` +
  `${i.partialFilterExpression ? ` partial=${JSON.stringify(i.partialFilterExpression)}` : ''}`;

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB\n');

  for (const model of MODELS) {
    const name = model.collection.collectionName;
    console.log(`=== ${name} ===`);

    const before = await model.collection.indexes();

    let dropped = [];
    try {
      dropped = await model.syncIndexes();
    } catch (error) {
      // A unique index cannot be built while duplicate values exist. Say which
      // constraint failed rather than dying with a raw driver error.
      console.error(`  FAILED: ${error.message}`);
      console.error('  Existing duplicate data must be resolved before this index can be created.\n');
      continue;
    }

    const after = await model.collection.indexes();
    const beforeNames = new Set(before.map((i) => i.name));
    const added = after.filter((i) => !beforeNames.has(i.name));

    if (dropped.length) dropped.forEach((n) => console.log(`  dropped  ${n}`));
    added.forEach((i) => console.log(`  created  ${describe(i)}`));
    if (!dropped.length && !added.length) console.log('  already in sync');
    console.log('');
  }

  console.log('Index sync complete.');
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Index sync failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
