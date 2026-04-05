import app from '../src/index.js';
import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';

// Configure connection pooling and resource limits
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  keepAliveMsecs: 30000,
  freeSocketTimeout: 90000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  keepAliveMsecs: 30000,
  freeSocketTimeout: 90000
});

// Attach agents to app for downstream requests
app.set('httpAgent', httpAgent);
app.set('httpsAgent', httpsAgent);

// Circuit breaker pattern for external service calls
class CircuitBreaker {
  constructor(name, threshold = 5, timeout = 60000) {
    if (!name) throw new Error('CircuitBreaker requires name');
    if (threshold <= 0) throw new Error('CircuitBreaker threshold must be positive');
    if (timeout <= 0) throw new Error('CircuitBreaker timeout must be positive');
    this.name = name;
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextRetryTime = null;
    this.successCount = 0;
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        throw new Error(`Circuit breaker OPEN for ${this.name}`);
      }
    }
    
    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        if (this.successCount >= 2) {
          this.state = 'CLOSED';
          this.failureCount = 0;
          this.successCount = 0;
        }
      } else if (this.state === 'CLOSED') {
        this.failureCount = Math.max(0, this.failureCount - 1);
      }
      this.lastFailureTime = null;
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      if (this.failureCount >= this.threshold) {
        this.state = 'OPEN';
        this.nextRetryTime = Date.now() + this.timeout;
      }
      throw error;
    }
  }
}

// Exponential backoff retry utility
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 100) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// Attach utilities to request context
app.use((req, res, next) => {
  req.retryWithBackoff = retryWithBackoff;
  req.CircuitBreaker = CircuitBreaker;
  next();
});

// Track active connections for monitoring
let activeConnections = 0;
const MAX_ACTIVE_CONNECTIONS = 1000;

app.use((req, res, next) => {
  activeConnections++;
  if (activeConnections > MAX_ACTIVE_CONNECTIONS) {
    activeConnections--;
    const err = new Error('Service overloaded');
    err.statusCode = 503;
    err.code = 'SERVICE_OVERLOADED';
    return next(err);
  }
  res.on('finish', () => activeConnections--);
  next();
});

// Validate app module is properly initialized
if (!app) {
  const errorMsg = 'Failed to initialize Express app from src/index.js - app module is null or undefined';
  console.error(`[INIT-ERROR] ${errorMsg}`);
  throw new Error(errorMsg);
}

// Request-level isolation middleware - prevent race conditions
const requestMutexes = new Map();

// Idempotency key tracking for mutation operations
const idempotencyCache = new Map();
const IDEMPOTENCY_TTL = 3600000; // 1 hour

const idempotencyMiddleware = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }
  
  const idempotencyKey = req.get('idempotency-key');
  if (!idempotencyKey) {
    return next();
  }
  
  // Check if this idempotency key was already processed
  if (idempotencyCache.has(idempotencyKey)) {
    const cached = idempotencyCache.get(idempotencyKey);
    return res.status(cached.statusCode).json(cached.response);
  }
  
  // Store original json method to intercept response
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // Cache the response with this idempotency key
    idempotencyCache.set(idempotencyKey, {
      statusCode: res.statusCode,
      response: data,
      timestamp: Date.now()
    });
    
    // Clean up old entries periodically
    if (idempotencyCache.size > 10000) {
      const now = Date.now();
      for (const [key, value] of idempotencyCache.entries()) {
        if (now - value.timestamp > IDEMPOTENCY_TTL) {
          idempotencyCache.delete(key);
        }
      }
    }
    
    return originalJson(data);
  };
  
  next();
};

app.use(idempotencyMiddleware);

// Request validation and sanitization middleware
const validateRequest = (req, res, next) => {
  try {
    // Validate content-type for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('content-type');
      if (!contentType) {
        const err = new Error('Missing Content-Type header');
        err.statusCode = 400;
        err.code = 'MISSING_CONTENT_TYPE';
        return next(err);
      }
      if (!contentType.includes('application/json')) {
        const err = new Error('Content-Type must be application/json');
        err.statusCode = 415;
        err.code = 'UNSUPPORTED_MEDIA_TYPE';
        return next(err);
      }
    }
    
    // Sanitize request parameters
    if (req.query) {
      Object.keys(req.query).forEach(key => {
        const value = req.query[key];
        if (typeof value === 'string') {
          // Remove potential XSS vectors
          req.query[key] = value.replace(/[<>"']/g, '');
        }
      });
    }
    
    next();
  } catch (err) {
    next(err);
  }
};

app.use(validateRequest);

// Health check endpoints for load balancer integration
app.get('/health', (req, res) => {
  // Liveness probe - responds immediately, no dependency checks
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    requestId: randomUUID()
  });
});

app.get('/ready', async (req, res) => {
  // Readiness probe - verifies service readiness before accepting traffic
  try {
    const checks = {
      uptime: process.uptime() > 0,
      memoryUsage: process.memoryUsage().heapUsed < process.memoryUsage().heapTotal * 0.95,
      timestamp: new Date().toISOString()
    };
    const ready = Object.values(checks).every(v => v === true);
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      ...checks
    });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      error: 'Readiness check failed'
    });
  }
});

app.use((req, res, next) => {
  const requestId = randomUUID();
  req.requestId = requestId;
  req.requestMutex = {}; // Per-request mutex lock holder
  
  // Request timeout enforcement
  const DEFAULT_TIMEOUT = 30000; // 30 seconds
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      const err = new Error('Request timeout');
      err.statusCode = 408;
      err.code = 'REQUEST_TIMEOUT';
      next(err);
    }
  }, DEFAULT_TIMEOUT);
  
  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));
  
  // Track request deadline
  req.deadline = Date.now() + DEFAULT_TIMEOUT;
  req.isDeadlineExceeded = () => Date.now() > req.deadline;
  req.acquireLock = async (key) => {
    if (!requestMutexes.has(key)) {
      requestMutexes.set(key, { locked: false, queue: [] });
    }
    const lockEntry = requestMutexes.get(key);
    if (lockEntry.locked) {
      await new Promise(resolve => lockEntry.queue.push(resolve));
    }
    lockEntry.locked = true;
    return () => {
      lockEntry.locked = false;
      const next = lockEntry.queue.shift();
      if (next) next();
    };
  };
  next();
});

// Request validation middleware - prevent malformed requests early
app.use((req, res, next) => {
  // Validate content-type for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'];
    if (!contentType?.includes('application/json')) {
      req.log.warn('invalid_content_type', { contentType });
      return res.status(400).json({
        error: 'Invalid Content-Type. Expected application/json',
        correlationId: req.correlationId
      });
    }
  }
  next();
});

// Timeout middleware for external API calls
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const UPSTREAM_TIMEOUT_MS = 25000; // 25 seconds for upstream calls

app.use((req, res, next) => {
  // Set response timeout
  res.setTimeout(DEFAULT_TIMEOUT_MS, () => {
    req.log.error('response_timeout', { timeout: DEFAULT_TIMEOUT_MS });
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway Timeout', correlationId: req.correlationId });
    }
    req.socket?.destroy();
  });
  
  // Store timeout config for use in external calls
  req.upstreamTimeout = UPSTREAM_TIMEOUT_MS;
  next();
});

// Queue manager with backpressure limits
class BoundedQueue {
  constructor(maxSize = 1000) {
    this.queue = [];
    this.maxSize = maxSize;
    this.processing = 0;
    this.metrics = { total: 0, dropped: 0, processed: 0 };
  }
  
  enqueue(job) {
    if (this.queue.length >= this.maxSize) {
      this.metrics.dropped++;
      throw new Error(`Queue full: ${this.maxSize} items (backpressure triggered)`);
    }
    this.queue.push(job);
    this.metrics.total++;
    return this.metrics.total;
  }
  
  async process(handler) {
    if (this.queue.length === 0) return;
    const job = this.queue.shift();
    this.processing++;
    try {
      await handler(job);
      this.metrics.processed++;
    } catch (err) {
      console.error(`Queue job failed: ${err.message}`);
    } finally {
      this.processing--;
    }
  }
  
  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      maxSize: this.maxSize,
      metrics: this.metrics
    };
  }
}

app.jobQueue = new BoundedQueue(1000);

// Utility for making external calls with timeout
app.makeExternalCall = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || UPSTREAM_TIMEOUT_MS);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Upstream call timeout after ${options.timeout || UPSTREAM_TIMEOUT_MS}ms`);
    }
    throw err;
  }
};

// Request correlation ID middleware for distributed tracing with structured logging
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || randomUUID();
  const traceId = req.headers['x-trace-id'] || randomUUID();
  req.id = correlationId;
  req.traceId = traceId;
  res.setHeader('x-correlation-id', correlationId);
  res.setHeader('x-trace-id', traceId);
  res.setHeader('x-request-id', req.requestId);
  
  const requestStart = Date.now();
  const logContext = {
    correlationId,
    traceId,
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('user-agent')
  };
  
  // Structured logging helper with JSON formatting and correlation context
  req.log = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', ...logContext, msg, ...meta, timestamp: new Date().toISOString() })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error', ...logContext, msg, ...meta, timestamp: new Date().toISOString() })),
    warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', ...logContext, msg, ...meta, timestamp: new Date().toISOString() }))
  };
  
  console.log(JSON.stringify({ level: 'info', event: 'REQUEST_START', ...logContext, timestamp: new Date().toISOString() }));
  
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const duration = Date.now() - requestStart;
    console.log(JSON.stringify({ level: 'info', event: 'REQUEST_END', ...logContext, statusCode: res.statusCode, duration, timestamp: new Date().toISOString() }));
    return originalJson(data);
  };
  
  next();
});

// External API call timeout wrapper with graceful termination
const DEFAULT_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '30000', 10);
const EXTERNAL_API_TIMEOUT_MS = parseInt(process.env.EXTERNAL_API_TIMEOUT_MS || '10000', 10);

function createTimeoutPromise(timeoutMs) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
  );
}

async function callExternalApiWithTimeout(fetchFn, timeoutMs = EXTERNAL_API_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const result = await Promise.race([
        fetchFn(controller.signal),
        createTimeoutPromise(timeoutMs)
      ]);
      clearTimeout(timeoutHandle);
      return result;
    } catch (err) {
      clearTimeout(timeoutHandle);
      controller.abort();
      throw err;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`External API call aborted: timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// Standardized error response schema
class ApiError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
  
  toJSON(correlationId = 'unknown') {
    return {
      error: {
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        timestamp: this.timestamp,
        correlationId,
        details: process.env.NODE_ENV === 'development' ? this.details : undefined
      }
    };
  }
}

// Common error codes and status codes
const ErrorCodes = {
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', status: 400 },
  UNAUTHORIZED: { code: 'UNAUTHORIZED', status: 401 },
  FORBIDDEN: { code: 'FORBIDDEN', status: 403 },
  NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  CONFLICT: { code: 'CONFLICT', status: 409 },
  RATE_LIMITED: { code: 'RATE_LIMITED', status: 429 },
  TIMEOUT: { code: 'TIMEOUT', status: 504 },
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', status: 500 }
};

// Async request wrapper to catch unhandled promise rejections in handlers
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const correlationId = req.id || 'unknown';
      console.error(`[${correlationId}] Unhandled promise rejection in async handler:`, err.message);
      next(err);
    });
  };
}

// Global unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  const correlationId = reason?.correlationId || 'unknown';
  console.error(`[${correlationId}] Unhandled promise rejection:`, reason);
});

// Comprehensive error handling middleware
app.use((err, req, res, next) => {
  console.error('API Error:', err.message, err.stack);
  const statusCode = err.statusCode || (err.message.includes('timeout') ? 504 : 500);
  const errorCode = err.code || 'INTERNAL_ERROR';
  res.status(statusCode).json({ 
    error: {
      message: err.message || 'Internal Server Error',
      code: errorCode,
      statusCode: statusCode,
      timestamp: new Date().toISOString(),
      correlationId: req.id,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    }
  });
});

// Request-level isolation and mutex pattern for concurrent request handling
const requestContextMap = new WeakMap();
const requestMutexMap = new Map();

function acquireMutex(requestId) {
  if (!requestMutexMap.has(requestId)) {
    requestMutexMap.set(requestId, Promise.resolve());
  }
  return requestMutexMap.get(requestId);
}

function releaseMutex(requestId, nextPromise) {
  requestMutexMap.set(requestId, nextPromise);
}

// Request context isolation middleware
app.use((req, res, next) => {
  const requestContext = {
    id: req.id,
    startTime: Date.now(),
    state: {},
    mutex: Promise.resolve()
  };
  requestContextMap.set(req, requestContext);
  
  res.on('finish', () => {
    requestMutexMap.delete(req.id);
    requestContextMap.delete(req);
  });
  
  next();
});

// Async operation wrapper to enforce mutex protection
async function withMutexLock(req, asyncFn) {
  const context = requestContextMap.get(req);
  if (!context) throw new Error('Request context not found');
  
  const currentMutex = context.mutex;
  let resolveMutex;
  const nextMutex = new Promise(resolve => { resolveMutex = resolve; });
  context.mutex = nextMutex;
  
  try {
    await currentMutex;
    return await asyncFn();
  } finally {
    resolveMutex();
  }
}

// Bounded queue with backpressure and overflow rejection
class BoundedQueue {
  constructor(maxSize = 1000, overflowStrategy = 'reject') {
    this.queue = [];
    this.maxSize = maxSize;
    this.overflowStrategy = overflowStrategy; // 'reject' or 'drop-oldest'
    this.waiters = [];
  }
  
  async enqueue(item) {
    if (this.queue.length >= this.maxSize) {
      if (this.overflowStrategy === 'reject') {
        const err = new Error(`Queue is full (size: ${this.maxSize}). Job rejected to prevent memory exhaustion.`);
        err.statusCode = 429;
        throw err;
      } else if (this.overflowStrategy === 'drop-oldest') {
        this.queue.shift();
        console.warn(`Queue full. Dropped oldest item. Current size: ${this.queue.length}/${this.maxSize}`);
      }
    }
    
    this.queue.push(item);
    this.notifyWaiters();
  }
  
  dequeue() {
    return this.queue.shift();
  }
  
  size() {
    return this.queue.length;
  }
  
  isFull() {
    return this.queue.length >= this.maxSize;
  }
  
  notifyWaiters() {
    while (this.waiters.length > 0 && this.queue.length > 0) {
      const resolver = this.waiters.shift();
      resolver();
    }
  }
}

const backgroundJobQueue = new BoundedQueue(parseInt(process.env.JOB_QUEUE_MAX_SIZE || '1000', 10), 'reject');

// Health check state tracking
let isReady = false;
let activeConnections = new Set();
let isShuttingDown = false;

// Liveness probe: indicates whether the process is running
app.get('/health/live', (req, res) => {
  const correlationId = req.id || 'unknown';
  console.log(`Liveness probe received [${correlationId}]`);
  res.status(200).json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    pid: process.pid,
    correlationId
  });
});

// Readiness probe: indicates whether the service is ready to accept requests
app.get('/health/ready', (req, res) => {
  const correlationId = req.id || 'unknown';
  if (!isReady) {
    console.warn(`Readiness probe failed: service not ready [${correlationId}]`);
    return res.status(503).json({ 
      status: 'not-ready',
      reason: 'Service initializing',
      correlationId
    });
  }
  console.log(`Readiness probe succeeded [${correlationId}]`);
  res.status(200).json({ 
    status: 'ready',
    activeConnections: activeConnections.size,
    queueSize: backgroundJobQueue.size(),
    timestamp: new Date().toISOString(),
    correlationId
  });
});

// Graceful shutdown handler
function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received signal: ${signal}`);
  if (isShuttingDown) {
    console.log('[SHUTDOWN] Already shutting down, ignoring signal');
    return;
  }
  
  isShuttingDown = true;
  console.log('[SHUTDOWN] Starting graceful shutdown...');
  
  // Stop accepting new requests
  app.set('isShuttingDown', true);
  
  // Drain active connections with timeout
  const drainTimeout = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || '30000', 10);
  const drainStartTime = Date.now();
  
  const drainInterval = setInterval(() => {
    const elapsed = Date.now() - drainStartTime;
    const remaining = activeConnections.size;
    console.log(`[SHUTDOWN] Draining: ${remaining} active connections, elapsed: ${elapsed}ms`);
    
    if (remaining === 0 || elapsed > drainTimeout) {
      clearInterval(drainInterval);
      if (remaining > 0) {
        console.warn(`[SHUTDOWN] Force closing ${remaining} remaining connections after ${drainTimeout}ms timeout`);
        activeConnections.forEach(conn => conn.destroy());
      }
      console.log('[SHUTDOWN] Shutdown complete');
      process.exit(0);
    }
  }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Exponential backoff retry strategy
async function retryWithExponentialBackoff(
  operation,
  maxRetries = 3,
  initialDelayMs = 100,
  maxDelayMs = 30000,
  correlationId = 'unknown'
) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${correlationId}] Attempt ${attempt + 1}/${maxRetries + 1}`);
      return await operation();
    } catch (err) {
      lastError = err;
      
      if (attempt === maxRetries) {
        console.error(`[${correlationId}] All ${maxRetries + 1} retries exhausted`, err.message);
        throw err;
      }
      
      const backoffMs = Math.min(
        initialDelayMs * Math.pow(2, attempt),
        maxDelayMs
      );
      
      console.warn(`[${correlationId}] Retry attempt ${attempt + 1} failed. Waiting ${backoffMs}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  throw lastError;
}

// Circuit breaker pattern for external service reliability
class CircuitBreaker {
  constructor(name, failureThreshold = 5, resetTimeoutMs = 60000) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
  }
  
  async execute(operation, correlationId = 'unknown') {
    if (this.state === 'OPEN') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      
      if (timeSinceLastFailure > this.resetTimeoutMs) {
        console.log(`[${correlationId}] Circuit breaker [${this.name}] attempting to recover (HALF_OPEN)`);
        this.state = 'HALF_OPEN';
      } else {
        const err = new Error(`Circuit breaker [${this.name}] is OPEN. Service unavailable.`);
        err.statusCode = 503;
        throw err;
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(correlationId);
      throw err;
    }
  }
  
  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker] Circuit breaker [${this.name}] recovered (CLOSED)`);
    }
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  onFailure(correlationId) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    console.warn(`[${correlationId}] Circuit breaker [${this.name}] failure ${this.failureCount}/${this.failureThreshold}`);
    
    if (this.failureCount >= this.failureThreshold) {
      console.error(`[${correlationId}] Circuit breaker [${this.name}] opened after ${this.failureCount} failures`);
      this.state = 'OPEN';
    }
  }
}

const externalServiceCircuitBreaker = new CircuitBreaker('external-api', 5, 60000);

// Request validation wrapper with proper null/undefined handling
function validateRequest(req, res, next) {
  try {
    if (!req || !req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    next();
  } catch (validationError) {
    console.error('Validation Error:', validationError.message);
    res.status(400).json({ error: 'Invalid Request', details: validationError.message });
  }
}

app.use(validateRequest);

// Fixed mobile API endpoints with proper format handling and null checks
function processData(data) {
  if (!data) {
    throw new Error('Data cannot be null or undefined');
  }
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (e) {
      console.warn('Failed to parse data as JSON:', e.message);
      return data;
    }
  }
  return data;
}

app.post('/api/mobile/endpoint', validateRequest, asyncHandler(async (req, res) => {
  try {
    const { userId, data } = req.body;
    
    if (!userId || !data) {
      return res.status(400).json({ 
        error: {
          message: 'Missing required fields',
          code: ErrorCodes.VALIDATION_ERROR.code,
          statusCode: ErrorCodes.VALIDATION_ERROR.status,
          required: ['userId', 'data'],
          timestamp: new Date().toISOString(),
          correlationId: req.id
        }
      });
    }
    
    // Consistent response format for mobile with transaction retry
    const response = await executeWithTransactionRetry(
      async () => ({
        status: 'success',
        data: processData(data),
        timestamp: new Date().toISOString(),
        version: '1.0'
      }),
      3,
      100,
      req.id
    );
    
    res.status(200).json(response);
  } catch (error) {
    console.error('Mobile endpoint error:', error);
    res.status(500).json({ 
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Database connection pool configuration
const dbPoolConfig = {
  min: parseInt(process.env.DB_POOL_MIN || '5', 10),
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  acquireTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT_MS || '30000', 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
  reapIntervalMillis: parseInt(process.env.DB_REAP_INTERVAL_MS || '1000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000', 10)
};

console.log('[DB-POOL] Configured with:', dbPoolConfig);

// Transaction retry wrapper with exponential backoff
async function executeWithTransactionRetry(
  operation,
  maxRetries = 3,
  initialDelayMs = 100,
  correlationId = 'unknown'
) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DB-RETRY] Attempt ${attempt}/${maxRetries} for operation [${correlationId}]`);
      return await operation();
    } catch (err) {
      lastError = err;
      const isTransient = err.message.includes('ECONNREFUSED') || 
                         err.message.includes('timeout') ||
                         err.code === 'ETIMEDOUT';
      
      if (!isTransient || attempt === maxRetries) {
        console.error(`[DB-RETRY] Operation failed permanently [${correlationId}]:`, err.message);
        throw err;
      }
      
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[DB-RETRY] Transient error detected. Retrying in ${delayMs}ms [${correlationId}]:`, err.message);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// Log successful initialization
console.log('[INIT-SUCCESS] API module initialized successfully');

// Centralized error handling middleware
app.use((err, req, res, next) => {
  const errorId = randomUUID();
  const timestamp = new Date().toISOString();
  
  // Structured error logging with correlation ID
  const errorContext = {
    errorId,
    requestId: req.requestId,
    timestamp,
    method: req.method,
    path: req.path,
    statusCode: err.statusCode || 500,
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  };
  console.error('[ERROR]', JSON.stringify(errorContext));
  
  // Determine HTTP status and client-facing message
  const statusCode = err.statusCode || (err.name === 'ValidationError' ? 400 : 500);
  const clientMessage = statusCode === 500 ? 'Internal server error' : err.message || 'Request failed';
  
  res.status(statusCode).json({
    error: {
      id: errorId,
      message: clientMessage,
      code: err.code || 'UNKNOWN_ERROR'
    },
    requestId: req.requestId
  });
});

// Graceful degradation for unhandled errors
process.on('uncaughtException', (error) => {
  console.error('[FATAL]', JSON.stringify({
    type: 'uncaughtException',
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  }));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL]', JSON.stringify({
    type: 'unhandledRejection',
    reason: String(reason),
    timestamp: new Date().toISOString()
  }));
});

export default app;