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

// Database Connection
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
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

// API Endpoint Mounting
app.use('/api/associates', associateRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/tree', treeRoutes);
app.use('/api/reports', reportRoutes);

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