const mongoose = require('mongoose');

// Atomic sequence generator. One document per sequence (e.g. _id: 'memberCode').
// Never derive a sequence from countDocuments() — two concurrent registrations
// would read the same count and mint duplicate codes.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

// Returns the next value for a sequence, incrementing it atomically.
counterSchema.statics.next = async function (name, session = null) {
  const counter = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return counter.seq;
};

// Raises a sequence so it sits at or above `value` (used after a migration
// backfills existing records, so newly minted codes never collide with them).
counterSchema.statics.raiseTo = async function (name, value) {
  const current = await this.findById(name);
  if (!current || current.seq < value) {
    await this.findByIdAndUpdate(name, { seq: value }, { upsert: true });
  }
};

module.exports = mongoose.model('Counter', counterSchema);
