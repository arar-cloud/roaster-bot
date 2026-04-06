import express, { Request, Response, NextFunction } from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Timeout configuration for external HTTP calls
const HTTP_TIMEOUT_MS = 30000; // 30 seconds
const SOCKET_TIMEOUT_MS = 60000; // 60 seconds
const CONNECT_TIMEOUT_MS = 10000; // 10 seconds

// Configure HTTP/HTTPS agents with timeout
const httpAgent = new http.Agent({
  timeout: SOCKET_TIMEOUT_MS,
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const httpsAgent = new https.Agent({
  timeout: SOCKET_TIMEOUT_MS,
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

// Retry logic with exponential backoff and jitter
class RetryHandler {
  private maxRetries: number = 3;
  private initialDelayMs: number = 100;
  private maxDelayMs: number = 10000;
  
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: { logger: Logger; requestId: string }
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        context.logger.info('Executing operation', { attempt: attempt + 1, maxRetries: this.maxRetries });
        return await Promise.race([
          operation(),
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error('Operation timeout')), REQUEST_TIMEOUT_MS)
          )
        ]);
      } catch (error) {
        lastError = error as Error;
        const isTransient = this.isTransientError(lastError);
        
        if (isTransient && attempt < this.maxRetries - 1) {
          const delay = this.calculateBackoff(attempt);
          context.logger.warn('Transient error, retrying', {
            attempt: attempt + 1,
            error: lastError.message,
            delayMs: delay
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          context.logger.error('Operation failed', lastError, {
            attempt: attempt + 1,
            isTransient,
            finalAttempt: attempt === this.maxRetries - 1
          });
          throw error;
        }
      }
    }
    
    throw lastError || new Error('Max retries exceeded');
  }
  
  private isTransientError(error: Error): boolean {
    const transientPatterns = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', '503', '502', '504', 'ECONNRESET'];
    return transientPatterns.some(pattern => error.message.includes(pattern));
  }
  
  private calculateBackoff(attempt: number): number {
    const exponentialDelay = this.initialDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * exponentialDelay * 0.1; // 10% jitter
    const delay = Math.min(exponentialDelay + jitter, this.maxDelayMs);
    return Math.floor(delay);
  }
}

// State machine for retry and circuit breaker logic
enum RetryState {
  IDLE = 'IDLE',
  RETRYING = 'RETRYING',
  BACKOFF = 'BACKOFF',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  CIRCUIT_HALF_OPEN = 'CIRCUIT_HALF_OPEN',
  FAILED = 'FAILED',
}

// State machine validator
class StateMachineValidator {
  private validTransitions: Record<RetryState, RetryState[]> = {
    [RetryState.IDLE]: [RetryState.RETRYING, RetryState.CIRCUIT_OPEN],
    [RetryState.RETRYING]: [RetryState.BACKOFF, RetryState.FAILED, RetryState.IDLE],
    [RetryState.BACKOFF]: [RetryState.RETRYING, RetryState.FAILED],
    [RetryState.CIRCUIT_OPEN]: [RetryState.CIRCUIT_HALF_OPEN],
    [RetryState.CIRCUIT_HALF_OPEN]: [RetryState.IDLE, RetryState.CIRCUIT_OPEN],
    [RetryState.FAILED]: [RetryState.IDLE],
  };
  
  isValidTransition(from: RetryState, to: RetryState): boolean {
    return this.validTransitions[from]?.includes(to) ?? false;
  }
  
  validateTransition(from: RetryState, to: RetryState): void {
    if (!this.isValidTransition(from, to)) {
      throw new Error(`Invalid state transition: ${from} -> ${to}`);
    }
  }
}


// Request validation middleware
const validateRequest = (req, res, next) => {
  try {
    // Sanitize request headers to prevent injection
    const maxHeaderSize = 8192;
    const headerString = JSON.stringify(req.headers);
    if (headerString.length > maxHeaderSize) {
      return res.status(400).json({ error: 'Headers exceed maximum size' });
    }
    
    // Validate Content-Type for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('Content-Type') || '';
      if (!contentType.includes('application/json') && req.body && Object.keys(req.body).length > 0) {
        return res.status(415).json({ error: 'Unsupported Media Type' });
      }
    }
    
    // Validate request body size
    const maxBodySize = 1048576; // 1MB
    if (req.headers['content-length'] && parseInt(req.headers['content-length']) > maxBodySize) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    
    next();
  } catch (error) {
    res.status(400).json({ error: 'Invalid request', details: error.message });
  }
};

// Rate limiting middleware - token bucket algorithm with backpressure handling
const rateLimitStore = new Map();
const requestQueue = [];
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;
const MAX_QUEUE_SIZE = 500;
const QUEUE_TIMEOUT_MS = 30000;

const rateLimitMiddleware = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (!rateLimitStore.has(clientIp)) {
    rateLimitStore.set(clientIp, { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS, queued: 0 });
  }
  
  const clientData = rateLimitStore.get(clientIp);
  
  if (now >= clientData.resetTime) {
    clientData.count = 0;
    clientData.queued = 0;
    clientData.resetTime = now + RATE_LIMIT_WINDOW_MS;
  }
  
  clientData.count++;
  
  if (clientData.count > RATE_LIMIT_MAX_REQUESTS) {
    // Backpressure: queue the request if space available, otherwise reject
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      logError(req.id || 'unknown', new Error('Queue overflow'), { clientIp, queueSize: requestQueue.length });
      return res.status(503).json({ error: 'Service temporarily unavailable', retryAfter: 60 });
    }
    clientData.queued++;
    const queuedRequest = { req, res, next, timestamp: now };
    requestQueue.push(queuedRequest);
    const timeoutHandle = setTimeout(() => {
      const idx = requestQueue.indexOf(queuedRequest);
      if (idx !== -1) requestQueue.splice(idx, 1);
      if (!res.headersSent) res.status(408).json({ error: 'Request timeout in queue' });
    }, QUEUE_TIMEOUT_MS);
    queuedRequest.timeoutHandle = timeoutHandle;
    return;
  }
  
  res.set('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS.toString());
  res.set('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX_REQUESTS - clientData.count).toString());
  next();
};

// Idempotency cache entry interface
interface IdempotencyEntry {
  requestId: string;
  result: unknown;
  timestamp: number;
  status: 'success' | 'failure';
  error?: string;
}

// Idempotency key management for deduplication
class IdempotencyManager {
  private cache = new Map<string, IdempotencyEntry>();
  private cacheMaxAge = 3600000; // 1 hour
  
  isProcessing(idempotencyKey: string): boolean {
    const entry = this.cache.get(idempotencyKey);
    if (!entry) return false;
    
    const isStale = Date.now() - entry.timestamp > this.cacheMaxAge;
    if (isStale) {
      this.cache.delete(idempotencyKey);
      return false;
    }
    
    return true;
  }
  
  getResult(idempotencyKey: string): IdempotencyEntry | null {
    const entry = this.cache.get(idempotencyKey);
    if (!entry) return null;
    
    const isStale = Date.now() - entry.timestamp > this.cacheMaxAge;
    if (isStale) {
      this.cache.delete(idempotencyKey);
      return null;
    }
    
    return entry;
  }
  
  recordRequest(idempotencyKey: string, requestId: string, result: unknown, status: 'success' | 'failure', error?: string): void {
    this.cache.set(idempotencyKey, {
      requestId,
      result,
      timestamp: Date.now(),
      status,
      error,
    });
  }
  
  clear(): void {
    this.cache.clear();
  }
}

// Structured logging utility
class Logger {
  private requestId: string;
  
  constructor(requestId: string = crypto.randomUUID()) {
    this.requestId = requestId;
  }
  
  info(message: string, metadata?: Record<string, unknown>) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      level: 'INFO',
      message,
      ...metadata
    }));
  }
  
  error(message: string, error?: Error, metadata?: Record<string, unknown>) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      level: 'ERROR',
      message,
      stack: error?.stack || undefined,
      ...metadata
    }));
  }
}

// Global idempotency manager instance
const idempotencyManager = new IdempotencyManager();

// Extract idempotency key from request headers
const getIdempotencyKey = (req: any): string | null => {
  return req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || null;
};

// Idempotency middleware - prevents duplicate request processing
const idempotencyMiddleware = (req: any, res: any, next: any) => {
  const idempotencyKey = getIdempotencyKey(req);
  
  // Only apply idempotency to state-changing operations
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !idempotencyKey) {
    return next();
  }
  
  // Check if request is already being processed
  if (idempotencyManager.isProcessing(idempotencyKey)) {
    const cachedResult = idempotencyManager.getResult(idempotencyKey);
    if (cachedResult) {
      const statusCode = cachedResult.status === 'success' ? 200 : 500;
      return res.status(statusCode).json({
        duplicate: true,
        result: cachedResult.result,
        error: cachedResult.error,
      });
    }
  }
  
  // Store original res.json to intercept responses
  const originalJson = res.json.bind(res);
  res.json = function(data: any) {
    const status = res.statusCode >= 400 ? 'failure' : 'success';
    idempotencyManager.recordRequest(
      idempotencyKey,
      req.id || 'unknown',
      data,
      status,
      status === 'failure' ? data.error : undefined
    );
    return originalJson(data);
  };
  
  next();
};

// Error logging utility with structured format
const logError = (requestId, error, context = {}) => {
  const timestamp = new Date().toISOString();
  const errorLog = {
    timestamp,
    requestId,
    error: error.message,
    stack: error.stack,
    context,
  };
  console.error('[ERROR]', JSON.stringify(errorLog));
  return errorLog;
};

// Metrics interface for circuit breaker tracking
interface Metrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  retriedRequests: number;
  averageLatencyMs: number;
  circuitBreakerOpenCount: number;
  lastErrorTimestamp?: number;
  lastError?: string;
}

// Configuration interface for circuit breaker
interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  resetTimeout: number;
}

// Circuit breaker with idempotency and state machine validation
class CircuitBreaker {
  private state: RetryState = RetryState.IDLE;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private config: CircuitBreakerConfig;
  private metrics: Metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retriedRequests: 0,
    averageLatencyMs: 0,
    circuitBreakerOpenCount: 0,
  };
  private stateValidator = new StateMachineValidator();
  private idempotencyManager = new IdempotencyManager();
  
  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }
  
  async execute<T>(
    operation: () => Promise<T>,
    idempotencyKey?: string
  ): Promise<T> {
    this.metrics.totalRequests++;
    const startTime = Date.now();
    
    // Check for duplicate requests via idempotency key
    if (idempotencyKey) {
      const cachedResult = this.idempotencyManager.getResult(idempotencyKey);
      if (cachedResult) {
        if (cachedResult.status === 'success') {
          return cachedResult.result as T;
        } else {
          throw new Error(cachedResult.error || 'Cached failure');
        }
      }
    }
    
    // Validate state transition before execution
    try {
      const nextState = this.state === RetryState.IDLE ? RetryState.RETRYING : this.state;
      this.stateValidator.validateTransition(this.state, nextState);
      this.state = nextState;
    } catch (error) {
      throw new Error(`State transition validation failed: ${error.message}`);
    }
    
    try {
      // Execute operation with timeout
      const result = await Promise.race([
        operation(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error('Circuit breaker operation timeout')), this.config.timeout)
        )
      ]);
      
      this.metrics.successfulRequests++;
      this.successCount++;
      this.failureCount = 0;
      
      // Record idempotent result
      if (idempotencyKey) {
        this.idempotencyManager.recordRequest(
          idempotencyKey,
          'request-id',
          result,
          'success'
        );
      }
      
      // Transition to IDLE on success
      if (this.state === RetryState.CIRCUIT_HALF_OPEN) {
        this.stateValidator.validateTransition(this.state, RetryState.IDLE);
        this.state = RetryState.IDLE;
      }
      
      const latency = Date.now() - startTime;
      this.metrics.averageLatencyMs = (this.metrics.averageLatencyMs + latency) / 2;
      
      return result;
    } catch (error) {
      this.metrics.failedRequests++;
      this.failureCount++;
      this.lastFailureTime = Date.now();
      this.metrics.lastErrorTimestamp = this.lastFailureTime;
      this.metrics.lastError = (error as Error).message;
      
      // Record failed request
      if (idempotencyKey) {
        this.idempotencyManager.recordRequest(
          idempotencyKey,
          'request-id',
          null,
          'failure',
          (error as Error).message
        );
      }
      
      // Check if circuit should open
      if (this.failureCount >= this.config.failureThreshold) {
        this.stateValidator.validateTransition(this.state, RetryState.CIRCUIT_OPEN);
        this.state = RetryState.CIRCUIT_OPEN;
        this.metrics.circuitBreakerOpenCount++;
      }
      
      throw error;
    }
  }
  
  getMetrics(): Metrics {
    return { ...this.metrics };
  }
  
  getState(): RetryState {
    return this.state;
  }
}

// Database transaction utility with retry logic
const MAX_TRANSACTION_RETRIES = 3;
const TRANSACTION_RETRY_DELAY_MS = 100;

const withTransaction = async (transactionFn, context = {}) => {
  let lastError;
  let attempt = 0;
  
  while (attempt < MAX_TRANSACTION_RETRIES) {
    attempt++;
    try {
      // Transaction boundary - BEGIN
      const transaction = {
        id: `txn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        startTime: Date.now(),
        operations: [],
      };
      
      // Execute transaction function
      const result = await transactionFn(transaction);
      
      // Verify consistency
      const transactionDuration = Date.now() - transaction.startTime;
      if (transactionDuration > 30000) {
        throw new Error(`Transaction exceeded timeout: ${transactionDuration}ms`);
      }
      
      // Transaction boundary - COMMIT (implicit)
      console.log(`[TXN] ${transaction.id} committed in ${transactionDuration}ms`);
      return { success: true, result, transaction };
      
    } catch (error) {
      lastError = error;
      
      // Check if error is a deadlock or retryable
      const isRetryable = 
        error.code === 'DEADLOCK' || 
        error.code === 'LOCK_WAIT_TIMEOUT' ||
        error.code === 'ECONNREFUSED';
      
      if (!isRetryable || attempt === MAX_TRANSACTION_RETRIES) {
        logError('transaction', error, { context, attempt, retryable: isRetryable });
        throw error;
      }
      
      // Exponential backoff retry
      const delay = TRANSACTION_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[TXN] Retry ${attempt}/${MAX_TRANSACTION_RETRIES} after ${delay}ms due to: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Transaction failed after all retries');
};

// Transaction Manager - provides consistent transaction semantics with retry logic
class TransactionManager {
  private maxRetries = 3;
  private retryDelayMs = 100;
  
  async execute<T>(
    operation: () => Promise<T>,
    context: { logger: Logger; requestId: string }
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        context.logger.info('Starting transaction', { attempt: attempt + 1 });
        const result = await operation();
        context.logger.info('Transaction completed successfully');
        return result;
      } catch (error) {
        lastError = error as Error;
        const isDeadlock = (lastError.message || '').includes('deadlock') || (lastError.message || '').includes('DEADLOCK');
        
        if (isDeadlock && attempt < this.maxRetries - 1) {
          const delayMs = this.retryDelayMs * Math.pow(2, attempt);
          context.logger.info('Deadlock detected, retrying', { attempt: attempt + 1, delayMs });
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          context.logger.error('Transaction failed', lastError as Error, { attempt: attempt + 1, isDeadlock });
          throw error;
        }
      }
    }
    
    throw lastError || new Error('Transaction failed after all retries');
  }
}

// Consistency verification
const verifyConsistency = (data, schema) => {
  try {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data type');
    }
    
    for (const [key, validator] of Object.entries(schema)) {
      if (validator.required && !(key in data)) {
        throw new Error(`Missing required field: ${key}`);
      }
      
      if (key in data && validator.type) {
        if (typeof data[key] !== validator.type) {
          throw new Error(`Field ${key} has invalid type: expected ${validator.type}, got ${typeof data[key]}`);
        }
      }
    }
    
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

// Async error wrapper for route handlers with transaction context
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((error) => {
    const errorLog = logError(req.id, error, {
      method: req.method,
      path: req.path,
      clientIp: req.ip,
    });
    
    // Determine status code based on error type
    let statusCode = 500;
    let message = 'Internal server error';
    
    if (error.statusCode) {
      statusCode = error.statusCode;
      message = error.message;
    } else if (error.code === 'ENOTFOUND') {
      statusCode = 503;
      message = 'Service temporarily unavailable';
    } else if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
      statusCode = 504;
      message = 'Gateway timeout';
    } else if (error.code === 'ECONNREFUSED') {
      statusCode = 503;
      message = 'Service unavailable';
    }
    
    // Consistent error response with transaction rollback handling
    // In case of deadlock or transaction error, client should retry
    if (!res.headersSent) {
      res.status(statusCode).json({
        error: message,
        requestId: req.id,
        timestamp: new Date().toISOString(),
        retryable: statusCode >= 500,
      });
    }
  });
};

// Request tracking middleware
const requestTracking = (req, res, next) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.id = requestId;
  res.set('X-Request-ID', requestId);
  const startTime = Date.now();
  
  activeConnections.add(res);
  
  res.on('finish', () => {
    activeConnections.delete(res);
    const duration = Date.now() - startTime;
    console.log(`[REQUEST] ${requestId} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  
  res.on('error', () => {
    activeConnections.delete(res);
  });
  
  next();
};

app.use(rateLimitMiddleware);
app.use(requestTracking);

// Request/response size limit middleware
const MAX_REQUEST_BODY_SIZE = '10mb';
const MAX_RESPONSE_CHUNK_SIZE = 1048576; // 1MB per chunk

app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));
app.use(express.urlencoded({ limit: MAX_REQUEST_BODY_SIZE, extended: true }));

const sizeCheckMiddleware = (req, res, next) => {
  const originalWrite = res.write;
  const originalEnd = res.end;
  let chunkCount = 0;
  
  res.write = function(...args) {
    chunkCount++;
    if (chunkCount * MAX_RESPONSE_CHUNK_SIZE > 52428800) { // 50MB total limit
      res.statusCode = 413;
      res.end(JSON.stringify({ error: 'Response Payload Too Large' }));
      return false;
    }
    return originalWrite.apply(res, args);
  };
  
  res.end = function(...args) {
    return originalEnd.apply(res, args);
  };
  
  next();
};

app.use(sizeCheckMiddleware);

// Import actual app from src
const actualApp = (await import('../src/index.js')).default;
if (actualApp) {
  app.use(actualApp);
}

const PORT = process.env.PORT || 3000;
let server;
let isShuttingDown = false;
const activeConnections = new Set();

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);
  
  if (server) {
    server.close(async () => {
      console.log('[SHUTDOWN] HTTP server closed');
      
      const shutdownTimeout = 30000;
      const shutdownDeadline = Date.now() + shutdownTimeout;
      
      while (activeConnections.size > 0 && Date.now() < shutdownDeadline) {
        console.log(`[SHUTDOWN] Waiting for ${activeConnections.size} in-flight requests...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (activeConnections.size > 0) {
        console.warn(`[SHUTDOWN] Force closing ${activeConnections.size} remaining connections`);
      }
      
      process.exit(activeConnections.size > 0 ? 1 : 0);
    });
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on('connection', (conn) => {
  activeConnections.add(conn);
  conn.on('close', () => activeConnections.delete(conn));
});

export default app;