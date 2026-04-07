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

// 6. Idempotency key tracking
const idempotencyCache = new Map();
const IDEMPOTENCY_CACHE_TTL_MS = 3600000; // 1 hour

const idempotencyMiddleware = (req, res, next) => {
  const mutationMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!mutationMethods.includes(req.method)) {
    next();
    return;
  }
  
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    req.logger('warn', 'Mutation request without idempotency key');
    next();
    return;
  }
  
  const now = Date.now();
  const cacheEntry = idempotencyCache.get(idempotencyKey);
  
  if (cacheEntry && now - cacheEntry.timestamp < IDEMPOTENCY_CACHE_TTL_MS) {
    req.logger('info', `Idempotent retry detected for key ${idempotencyKey}`);
    res.status(cacheEntry.statusCode).json(cacheEntry.response);
    return;
  }
  
  // Wrap response.json to capture and cache the response
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const statusCode = res.statusCode;
    idempotencyCache.set(idempotencyKey, {
      statusCode,
      response: body,
      timestamp: Date.now(),
    });
    req.logger('info', `Cached idempotent response for key ${idempotencyKey}`);
    return originalJson(body);
  };
  
  next();
};

const cleanupIdempotencyCache = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache.entries()) {
    if (now - entry.timestamp > IDEMPOTENCY_CACHE_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
}, IDEMPOTENCY_CACHE_TTL_MS / 2);

// 7. Health checks and graceful shutdown
let isShuttingDown = false;
let activeRequests = 0;

const requestCounterMiddleware = (req, res, next) => {
  if (isShuttingDown && req.path !== '/health/ready') {
    res.status(503).json({ error: 'Service shutting down', correlationId: req.correlationId });
    return;
  }
  activeRequests += 1;
  res.on('finish', () => {
    activeRequests -= 1;
  });
  next();
};

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive', correlationId: req.correlationId });
});

app.get('/health/ready', (req, res) => {
  const isReady = !isShuttingDown && activeRequests < 1000; // threshold
  const statusCode = isReady ? 200 : 503;
  res.status(statusCode).json({
    status: isReady ? 'ready' : 'not_ready',
    activeRequests,
    shutdownInProgress: isShuttingDown,
    correlationId: req.correlationId,
  });
});

const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, starting graceful shutdown`);
  isShuttingDown = true;
  
  // Give in-flight requests time to complete (max 30 seconds)
  const shutdownTimeout = 30000;
  const checkInterval = setInterval(() => {
    if (activeRequests === 0) {
      clearInterval(checkInterval);
      logger.info('All in-flight requests completed, shutting down');
      process.exit(0);
    }
  }, 1000);
  
  setTimeout(() => {
    logger.warn(`Graceful shutdown timeout after ${shutdownTimeout}ms, forcing exit`);
    process.exit(1);
  }, shutdownTimeout);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 8. Circuit breaker and retry logic
const circuitBreakerStates = new Map();

const getCircuitBreaker = (serviceName) => {
  if (!circuitBreakerStates.has(serviceName)) {
    circuitBreakerStates.set(serviceName, {
      state: 'closed', // closed, open, half-open
      failures: 0,
      successes: 0,
      lastFailureTime: null,
      threshold: 5,
      resetTimeout: 60000,
    });
  }
  return circuitBreakerStates.get(serviceName);
};

const callWithCircuitBreaker = async (serviceName, fn, maxRetries = 3) => {
  const breaker = getCircuitBreaker(serviceName);
  
  if (breaker.state === 'open') {
    const timeSinceFailure = Date.now() - (breaker.lastFailureTime || 0);
    if (timeSinceFailure > breaker.resetTimeout) {
      breaker.state = 'half-open';
      breaker.successes = 0;
    } else {
      throw new Error(`Circuit breaker open for ${serviceName}`);
    }
  }
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();
      
      if (breaker.state === 'half-open') {
        breaker.successes += 1;
        if (breaker.successes >= 2) {
          breaker.state = 'closed';
          breaker.failures = 0;
        }
      } else {
        breaker.failures = 0;
      }
      
      return result;
    } catch (err) {
      if (attempt === maxRetries - 1) {
        breaker.failures += 1;
        breaker.lastFailureTime = Date.now();
        
        if (breaker.failures >= breaker.threshold) {
          breaker.state = 'open';
        }
        throw err;
      }
      
      const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
};

// 9. Input validation and sanitization
const validateRequest = (schema) => (req, res, next) => {
  const errors = [];
  
  // Validate body
  if (req.body) {
    if (schema.body) {
      for (const [key, rules] of Object.entries(schema.body)) {
        const value = req.body[key];
        if (rules.required && (value === undefined || value === null || value === '')) {
          errors.push(`Missing required field: ${key}`);
        }
        if (value !== undefined && rules.type && typeof value !== rules.type) {
          errors.push(`Invalid type for ${key}: expected ${rules.type}, got ${typeof value}`);
        }
        if (value !== undefined && rules.pattern && !rules.pattern.test(String(value))) {
          errors.push(`Invalid format for ${key}`);
        }
        if (value !== undefined && rules.maxLength && String(value).length > rules.maxLength) {
          errors.push(`${key} exceeds maximum length of ${rules.maxLength}`);
        }
      }
    }
  }
  
  // Validate query parameters
  if (schema.query) {
    for (const [key, rules] of Object.entries(schema.query)) {
      const value = req.query[key];
      if (rules.required && !value) {
        errors.push(`Missing required query parameter: ${key}`);
      }
      if (value !== undefined && rules.pattern && !rules.pattern.test(String(value))) {
        errors.push(`Invalid format for query parameter ${key}`);
      }
    }
  }
  
  if (errors.length > 0) {
    req.logger('warn', `Validation errors: ${errors.join(', ')}`);
    res.status(400).json({
      error: 'Validation failed',
      details: errors,
      correlationId: req.correlationId,
    });
    return;
  }
  
  next();
};

// 10. Sanitization helper
const sanitizeInput = (input) => {
  if (typeof input === 'string') {
    return input
      .replace(/[<>"']/g, '')
      .trim()
      .slice(0, 10000); // max string length
  }
  return input;
};

// 11. Request timeout and cancellation
const DEFAULT_TIMEOUT_MS = 30000;

const timeoutMiddleware = (timeoutMs = DEFAULT_TIMEOUT_MS) => (req, res, next) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      req.logger('warn', `Request timeout after ${timeoutMs}ms`);
      controller.abort();
      res.status(408).json({
        error: 'Request Timeout',
        timeout: timeoutMs,
        correlationId: req.correlationId,
      });
    }
  }, timeoutMs);
  
  req.controller = controller;
  req.signal = controller.signal;
  
  res.on('finish', () => clearTimeout(timeoutId));
  res.on('close', () => {
    clearTimeout(timeoutId);
    if (!controller.signal.aborted) controller.abort();
  });
  
  next();
};

const withTimeout = async (req, promise, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Operation timeout')), timeoutMs)
    ),
  ]);
};

// 5. Attach middleware to app
app.use(requestContextMiddleware);
app.use(requestCounterMiddleware);
app.use(rateLimitMiddleware);
app.use(idempotencyMiddleware);
app.use(timeoutMiddleware());

// Export all stability utilities
export {
  app,
  withErrorBoundary,
  logger,
  generateCorrelationId,
  rateLimitMiddleware,
  idempotencyMiddleware,
  timeoutMiddleware,
  validateRequest,
  sanitizeInput,
  callWithCircuitBreaker,
  getCircuitBreaker,
};
export default app;