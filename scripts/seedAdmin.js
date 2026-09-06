/**
 * Creates the first admin account.
 *
 *   npm run seed:admin
 *
 * The admin lives in the Associate collection but sits OUTSIDE the tree:
 * role 'admin', no memberCode, no tier, no parent. The tree root is a separate
 * record — the first associate this admin registers becomes TRG0001.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Associate = require('../models/Associate');
const { ROLES, STATUSES } = require('../config/constants');

const run = async () => {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const existing = await Associate.findOne({ email });
  if (existing) {
    console.log(`An account already exists for ${email} (role: ${existing.role}). Nothing to do.`);
    await mongoose.disconnect();
    return;
  }

  const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));

  const admin = await Associate.create({
    title: process.env.ADMIN_TITLE || 'Mr.',
    fullName: process.env.ADMIN_NAME || 'System Administrator',
    gender: process.env.ADMIN_GENDER || 'Other',
    phone: process.env.ADMIN_PHONE || '0000000000',
    email,
    password: hashed,
    role: ROLES.ADMIN,
    status: STATUSES.APPROVED,
    // Outside the tree: no memberCode, no tier, no placement.
    parentId: null,
    position: null,
    ancestors: [],
    depth: 0,
    // The .env password is shared/known — force a real one at first login.
    mustChangePassword: true
  });

  console.log('\nAdmin created');
  console.log(`  email : ${admin.email}`);
  console.log(`  role  : ${admin.role}`);
  console.log('\n  This account must change its password at first login.');
  console.log('  Next: log in and register the first associate — they become TRG0001, the tree root.\n');

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
