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

// 4. Rate limiting and backpressure handler
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // per client per window
const BACKPRESSURE_THRESHOLD = 0.8; // drain backlog if queue > 80%

const getRateLimitKey = (req) => {
  return req.headers['x-client-id'] || req.ip || req.socket.remoteAddress || 'unknown';
};

const rateLimitMiddleware = (req, res, next) => {
  const clientKey = getRateLimitKey(req);
  const now = Date.now();
  
  if (!rateLimitStore.has(clientKey)) {
    rateLimitStore.set(clientKey, { tokens: RATE_LIMIT_MAX_REQUESTS, lastRefill: now });
  }
  
  const bucket = rateLimitStore.get(clientKey);
  const timePassed = now - bucket.lastRefill;
  const tokensToAdd = (timePassed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_MAX_REQUESTS;
  
  bucket.tokens = Math.min(RATE_LIMIT_MAX_REQUESTS, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
  
  const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX_REQUESTS);
  
  if (bucket.tokens < 1) {
    req.logger('warn', `Rate limit exceeded for client ${clientKey}`);
    res.status(429).set('Retry-After', retryAfter).json({
      error: 'Too Many Requests',
      retryAfter,
      correlationId: req.correlationId,
    });
    return;
  }
  
  bucket.tokens -= 1;
  res.setHeader('X-RateLimit-Remaining', Math.floor(bucket.tokens));
  next();
};

const cleanupRateLimitStore = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitStore.entries()) {
    if (now - bucket.lastRefill > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// 5. Attach middleware to app
app.use(requestContextMiddleware);
app.use(rateLimitMiddleware);

export { app, withErrorBoundary, logger, generateCorrelationId };
export default app;