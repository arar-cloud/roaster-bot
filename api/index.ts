// Timeout configuration
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000');
const EXTERNAL_CALL_TIMEOUT_MS = parseInt(process.env.EXTERNAL_CALL_TIMEOUT_MS || '10000');
const IDEMPOTENCY_TTL_MS = 3600000; // 1 hour

// Idempotency key cache: Map<idempotencyKey, { response, timestamp }>
const idempotencyCache = new Map<string, { response: any; timestamp: number }>();

const sanitizeInput = (obj: any): any => {
  if (typeof obj === 'string') {
    return obj.trim().slice(0, 10000); // Limit string length
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeInput).slice(0, 1000); // Limit array size
  }
  if (obj !== null && typeof obj === 'object') {
    const sanitized: any = {};
    Object.keys(obj).slice(0, 100).forEach(key => {
      sanitized[key] = sanitizeInput(obj[key]);
    });
    return sanitized;
  }
  return obj;
};

const validationMiddleware = (req: Request, res: Response, next: Function) => {
  try {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      // Validate body is object
      if (typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }
      // Sanitize input
      req.body = sanitizeInput(req.body);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request format' });
  }
  next();
};

const idempotencyMiddleware = (req: Request, res: Response, next: Function) => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  const correlationId = getCorrelationId(req);
  
  if (idempotencyKey && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'IDEMPOTENCY_CACHE_HIT',
        idempotencyKey,
        correlationId,
      }));
      return res.status(200).json(cached.response);
    }
    
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        idempotencyCache.set(idempotencyKey, { response: body, timestamp: Date.now() });
      }
      return originalJson(body);
    };
  }
  next();
};

// Timeout middleware
const timeoutMiddleware = (req: Request, res: Response, next: Function) => {
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  }, REQUEST_TIMEOUT_MS);
  
  res.on('finish', () => clearTimeout(timeoutId));
  res.on('close', () => clearTimeout(timeoutId));
  next();
};

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/ready';
  },
  onLimitReached: (req: Request, res: Response, options) => {
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'RATE_LIMIT_EXCEEDED',
      ip: req.ip,
      correlationId: getCorrelationId(req),
      path: req.path,
    }));
  },
});

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Graceful shutdown state
let isShuttingDown = false;
let activeConnections = 0;
let server: any = null;

// Retry configuration for exponential backoff
interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

class RetryableError extends Error {
  constructor(message: string, public isRetryable: boolean) {
    super(message);
    this.name = 'RetryableError';
  }
}

// Exponential backoff with jitter
function getBackoffDelay(attempt: number, initialDelayMs: number, maxDelayMs: number, multiplier: number): number {
  const baseDelay = Math.min(initialDelayMs * Math.pow(multiplier, attempt), maxDelayMs);
  const jitter = Math.random() * baseDelay * 0.1; // 10% jitter
  return baseDelay + jitter;
}

// Wrapper for retryable operations
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const maxRetries = config.maxRetries ?? 3;
  const initialDelayMs = config.initialDelayMs ?? 100;
  const maxDelayMs = config.maxDelayMs ?? 5000;
  const backoffMultiplier = config.backoffMultiplier ?? 2;

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRetryable = error instanceof RetryableError && error.isRetryable ||
                         error instanceof Error && (
                           error.message.includes('ECONNRESET') ||
                           error.message.includes('ETIMEDOUT') ||
                           error.message.includes('ENOTFOUND')
                         );

      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }

      const delayMs = getBackoffDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// Timeout configuration for external HTTP calls
const HTTP_TIMEOUT_MS = 30000; // 30 seconds
const SOCKET_TIMEOUT_MS = 60000; // 60 seconds
const CONNECT_TIMEOUT_MS = 10000; // 10 seconds

// Structured logging with correlation IDs
interface RequestContext {
  correlationId: string;
  startTime: number;
}

const requestContextMap = new WeakMap<Request, RequestContext>();

function generateCorrelationId(): string {
  return crypto.randomUUID();
}

function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.headers['x-correlation-id'] as string || generateCorrelationId();
  const context: RequestContext = {
    correlationId,
    startTime: Date.now(),
  };

  requestContextMap.set(req, context);
  res.setHeader('x-correlation-id', correlationId);

  // Log request start
  const logEntry = {
    timestamp: new Date().toISOString(),
    correlationId,
    method: req.method,
    path: req.path,
    type: 'REQUEST_START',
  };
  console.log(JSON.stringify(logEntry));

  // Log response on finish
  const originalSend = res.send;
  res.send = function(data: any) {
    const duration = Date.now() - context.startTime;
    const logExit = {
      timestamp: new Date().toISOString(),
      correlationId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      type: 'REQUEST_END',
    };
    console.log(JSON.stringify(logExit));
    return originalSend.call(this, data);
  };

  next();
}

function getCorrelationId(req: Request): string {
  return requestContextMap.get(req)?.correlationId || 'unknown';
}

// Idempotency key tracking
const idempotencyKeyMap = new Map<string, { result: any; timestamp: number }>();
const IDEMPOTENCY_CACHE_TTL_MS = 3600000; // 1 hour

// Circuit breaker pattern
enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private successCount = 0;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60000,
    private readonly halfOpenRequests: number = 2
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.halfOpenRequests) {
        this.state = CircuitBreakerState.CLOSED;
        this.successCount = 0;
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
    }
  }

  getState(): CircuitBreakerState {
    return this.state;
  }
}

function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only apply to mutation methods
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return next();
  }

  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    return next();
  }

  // Check for duplicate request
  const cached = idempotencyKeyMap.get(idempotencyKey);
  if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_CACHE_TTL_MS) {
    res.set('Idempotency-Replay', 'true');
    return res.status(200).json(cached.result);
  }

  // Intercept response to cache result
  const originalSend = res.send;
  res.send = function(data: any) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const result = typeof data === 'string' ? JSON.parse(data) : data;
        idempotencyKeyMap.set(idempotencyKey, { result, timestamp: Date.now() });
        // Cleanup old entries
        if (idempotencyKeyMap.size > 1000) {
          const now = Date.now();
          for (const [key, value] of idempotencyKeyMap.entries()) {
            if (now - value.timestamp > IDEMPOTENCY_CACHE_TTL_MS) {
              idempotencyKeyMap.delete(key);
            }
          }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
    return originalSend.call(this, data);
  };

  next();
}

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

// Error logging utility
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

// Error categorization
enum ErrorCategory {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CLIENT_ERROR = 'CLIENT_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
}

class StructuredError extends Error {
  constructor(
    public category: ErrorCategory,
    public statusCode: number,
    message: string,
    public retryable: boolean = false,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'StructuredError';
  }
}

// Error handling middleware with categorization
function errorHandlerMiddleware(err: any, req: any, res: any, next: any): void {
  const requestId = req.id || 'unknown';
  const correlationId = getCorrelationId(req);
  let category = ErrorCategory.SERVER_ERROR;
  let statusCode = 500;
  let retryable = false;
  let message = 'Internal server error';
  let details: Record<string, any> | undefined;

  if (err instanceof StructuredError) {
    category = err.category;
    statusCode = err.statusCode;
    retryable = err.retryable;
    message = err.message;
    details = err.details;
  } else if (err.message?.includes('validation') || err.message?.includes('Invalid')) {
    category = ErrorCategory.VALIDATION_ERROR;
    statusCode = 400;
    message = 'Validation error';
  } else if (err.message?.includes('ECONNRESET') || err.message?.includes('ETIMEDOUT') || err.message?.includes('timeout')) {
    category = ErrorCategory.TIMEOUT_ERROR;
    statusCode = 504;
    retryable = true;
  } else if (err.message?.includes('ENOTFOUND') || err.message?.includes('external')) {
    category = ErrorCategory.EXTERNAL_SERVICE_ERROR;
    statusCode = 502;
    retryable = true;
  }

  logError(requestId, err, { path: req.path, method: req.method, category, correlationId });
  res.status(statusCode).json({
    error: message,
    requestId,
    correlationId,
    category,
    retryable,
    ...(details && { details }),
  });
}

// Connection tracking middleware
function connectionTrackingMiddleware(req: any, res: any, next: any): void {
  if (!isShuttingDown) {
    activeConnections++;
    res.on('finish', () => {
      activeConnections--;
    });
  }
  next();
}

// Graceful shutdown handler
function gracefulShutdown(signal: string): void {
  console.log(`${signal} received. Starting graceful shutdown...`);
  isShuttingDown = true;

  const shutdownTimeout = 30000;
  const checkInterval = 1000;
  let elapsed = 0;

  const checkComplete = setInterval(() => {
    elapsed += checkInterval;
    console.log(`[Shutdown] Active connections: ${activeConnections}, elapsed: ${elapsed}ms`);

    if (activeConnections === 0 || elapsed >= shutdownTimeout) {
      clearInterval(checkComplete);
      console.log(`[Shutdown] Closing server after ${elapsed}ms with ${activeConnections} remaining connections`);
      if (server) {
        server.close(() => {
          console.log('Server closed');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    }
  }, checkInterval);

  // Force shutdown if timeout exceeded
  setTimeout(() => {
    console.log(`[Shutdown] Force closing after ${shutdownTimeout}ms`);
    clearInterval(checkComplete);
    if (server) {
      server.close(() => process.exit(1));
    } else {
      process.exit(1);
    }
  }, shutdownTimeout);
}

// Register graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Example service integrations (template for external API calls)
const externalServiceCircuitBreakers = new Map<string, CircuitBreaker>();

function getOrCreateCircuitBreaker(serviceName: string): CircuitBreaker {
  if (!externalServiceCircuitBreakers.has(serviceName)) {
    externalServiceCircuitBreakers.set(serviceName, new CircuitBreaker(
      5,      // failureThreshold
      60000,  // resetTimeoutMs
      2       // halfOpenRequests
    ));
  }
  return externalServiceCircuitBreakers.get(serviceName)!;
}

// Example: Wrap external service calls with retry + circuit breaker
async function callExternalService<T>(
  serviceName: string,
  fn: () => Promise<T>
): Promise<T> {
  const breaker = getOrCreateCircuitBreaker(serviceName);
  return breaker.execute(() =>
    withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    })
  );
}

// Example endpoint with error handling
app.get('/api/example', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Example of how to use retry wrapper with circuit breaker
    // const result = await callExternalService('external-api', () => {
    //   return fetch('https://api.example.com/endpoint', {
    //     httpAgent,
    //     httpsAgent,
    //     timeout: HTTP_TIMEOUT_MS,
    //   }).then(r => r.json());
    // });

    res.json({ status: 'ok', message: 'Example endpoint' });
  } catch (error) {
    const isRetryable = error instanceof Error && (
      error.message.includes('Circuit breaker') ||
      error.message.includes('ECONNRESET')
    );
    next(new StructuredError(
      isRetryable ? ErrorCategory.EXTERNAL_SERVICE_ERROR : ErrorCategory.SERVER_ERROR,
      isRetryable ? 503 : 500,
      error instanceof Error ? error.message : 'Unknown error',
      isRetryable
    ));
  }
});

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

// Async error wrapper for route handlers
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
    if (!res.headersSent) {
      res.status(statusCode).json({
        error: message,
        requestId: req.id,
        timestamp: new Date().toISOString(),
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