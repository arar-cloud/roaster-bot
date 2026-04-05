import app from '../src/index.js';
import { randomUUID } from 'crypto';

// Validate app module is properly initialized
if (!app) {
  const errorMsg = 'Failed to initialize Express app from src/index.js - app module is null or undefined';
  console.error(`[INIT-ERROR] ${errorMsg}`);
  throw new Error(errorMsg);
}

// Request correlation ID middleware for distributed tracing
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || randomUUID();
  req.id = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  
  // Structured logging helper
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  
  console.log = (...args) => originalLog(`[${correlationId}]`, ...args);
  console.error = (...args) => originalError(`[${correlationId}]`, ...args);
  console.warn = (...args) => originalWarn(`[${correlationId}]`, ...args);
  
  res.on('finish', () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  });
  
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

// Comprehensive error handling middleware
app.use((err, req, res, next) => {
  console.error('API Error:', err.message, err.stack);
  const statusCode = err.statusCode || (err.message.includes('timeout') ? 504 : 500);
  res.status(statusCode).json({ 
    error: err.message || 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    correlationId: req.id
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

app.post('/api/mobile/endpoint', validateRequest, async (req, res) => {
  try {
    const { userId, data } = req.body;
    
    if (!userId || !data) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['userId', 'data'] 
      });
    }
    
    // Consistent response format for mobile
    const response = {
      status: 'success',
      data: processData(data),
      timestamp: new Date().toISOString(),
      version: '1.0'
    };
    
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

// Log successful initialization
console.log('[INIT-SUCCESS] API module initialized successfully');

export default app;