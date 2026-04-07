import app from '../src/index.js';

// Stability hardening: module reliability baseline

// 1. Structured logging and correlation IDs
const logger = {
  error: (msg, err, correlationId) => console.error(`[ERROR] [${correlationId}] ${msg}:`, err?.message || err),
  warn: (msg, correlationId) => console.warn(`[WARN] [${correlationId}] ${msg}`),
  info: (msg, correlationId) => console.info(`[INFO] [${correlationId}] ${msg}`),
};

// 2. Request context and correlation ID generation
const generateCorrelationId = () => `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const requestContextMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
  res.setHeader('x-correlation-id', req.correlationId);
  req.logger = (level, msg, err) => logger[level](msg, err, req.correlationId);
  next();
};

// 3. Error boundary wrapper for handlers
const withErrorBoundary = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    req.logger('error', 'Unhandled error in handler', err);
    res.status(err.statusCode || 500).json({
      error: err.message || 'Internal Server Error',
      correlationId: req.correlationId,
      timestamp: new Date().toISOString(),
    });
  }
};

// 4. Attach middleware to app
app.use(requestContextMiddleware);

export { app, withErrorBoundary, logger, generateCorrelationId };
export default app;