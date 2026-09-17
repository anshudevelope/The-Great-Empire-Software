const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');

// Load environment variables from .env file
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express 5 leaves req.body undefined when a request carries no body at all
// (e.g. a PATCH with no payload), so every `const { x } = req.body` in a
// controller would throw a TypeError instead of returning a clean 400.
// Normalising it once here keeps that guard out of every handler.
app.use((req, _res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});

/**
 * Transactions need a replica set or a sharded cluster. A bare local `mongod`
 * has neither, and utils/transaction.js deliberately falls back to running
 * WITHOUT a session there so a developer machine still works.
 *
 * That fallback is fine for tree writes — the conditional slot claim still
 * prevents an overwrite. It is not fine for the commission ledger, where it
 * silently removes cross-document atomicity in the one environment nobody
 * thinks to check. Nobody deploys to production on a standalone mongod on
 * purpose, so fail loudly at boot rather than discovering it in a payout run.
 */
const assertTransactionSupport = async (conn) => {
  const { setName, msg } = await conn.connection.db.admin().command({ hello: 1 });
  const supported = Boolean(setName) || msg === 'isdbgrid';

  if (supported) return;

  const warning =
    'MongoDB is a standalone server — transactions are unavailable. ' +
    'Commission writes stay individually atomic, but placement and payout will not commit together.';

  if (process.env.NODE_ENV === 'production') {
    console.error(`FATAL: ${warning} Refusing to start. Use a replica set.`);
    process.exit(1);
  }
  console.warn(`WARNING: ${warning}`);
};

// Database Connection
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    await assertTransactionSupport(conn);
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

connectDB();

// Routes Import
const associateRoutes = require('./routes/associateRoutes');
const authRoutes = require('./routes/authRoutes');
const referralRoutes = require('./routes/referralRoutes');
const treeRoutes = require('./routes/treeRoutes');
const reportRoutes = require('./routes/reportRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const companyRoutes = require('./routes/companyRoutes');
const commissionRoutes = require('./routes/commissionRoutes');
const payoutRoutes = require('./routes/payoutRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

// API Endpoint Mounting
app.use('/api/associates', associateRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/tree', treeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/settings', settingsRoutes);

// Health Check Route
app.get('/', (req, res) => {
  res.send({ status: 'API is running...' });
});

// Must be mounted last: the 404 catches anything no route claimed, and the
// error handler turns thrown errors into a structured response instead of
// leaking a stack trace or a driver message.
const { notFound, errorHandler } = require('./middlewares/errorHandler');
app.use(notFound);
app.use(errorHandler);

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});