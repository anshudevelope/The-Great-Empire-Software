/**
 * Structured error responses.
 *
 * The Almighty reference platform leaks raw SQL and file paths from an
 * unhandled AJAX endpoint — that is how its whole schema became readable from
 * the outside. Nothing here ever returns a driver message or a stack trace to
 * the client; the detail goes to the server log instead.
 */

const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `No route for ${req.method} ${req.originalUrl}` });
};

// Express identifies an error handler by its four-argument signature, so
// `next` must stay in the list even though it is not called.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;

  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err.message);
  if (status >= 500) console.error(err.stack);

  // Mongo duplicate key — turn it into something a user can act on rather than
  // echoing the raw index name.
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'value';
    return res.status(409).json({ success: false, message: `That ${field} is already registered.` });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: Object.values(err.errors || {})
        .map((e) => e.message)
        .join(', ') || 'Validation failed.'
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Malformed identifier.' });
  }

  return res.status(status).json({
    success: false,
    // A 5xx message may contain internal detail, so it is replaced wholesale.
    // Deliberate 4xx messages are written for the user and pass through.
    message: status >= 500 ? 'Something went wrong. Please try again.' : err.message
  });
};

module.exports = { notFound, errorHandler };
