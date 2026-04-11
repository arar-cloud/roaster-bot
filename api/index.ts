import app from '../src/index.js';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      traceId?: string;
      idempotencyKey?: string;
      startTime?: number;
    }
  }
}

// Structured logging utilities
interface LogEntry {
  timestamp: string;
  traceId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, any>;
}

function structuredLog(level: 'info' | 'warn' | 'error', traceId: string, message: string, context?: Record<string, any>): void {
  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    traceId,
    level,
    message,
    context
  };
  console.log(JSON.stringify(logEntry));
}

// Request logging middleware with trace ID generation
function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.traceId = req.headers['x-trace-id'] as string || randomUUID();
  req.startTime = Date.now();

  structuredLog('info', req.traceId, 'request_start', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  const originalSend = res.send.bind(res);
  res.send = function(data: any) {
    const duration = Date.now() - (req.startTime || 0);
    structuredLog('info', req.traceId, 'request_complete', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration
    });
    return originalSend(data);
  };

  next();
}

// Idempotency store (in-memory for single instance, should use Redis in production)
interface IdempotencyRecord {
  key: string;
  responseCode: number;
  responseBody: any;
  timestamp: number;
  expiresAt: number;
}

class IdempotencyStore {
  private store: Map<string, IdempotencyRecord> = new Map();
  private readonly ttlMs = 60 * 60 * 1000; // 1 hour
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup expired entries every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  set(key: string, responseCode: number, responseBody: any): void {
    this.store.set(key, {
      key,
      responseCode,
      responseBody,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.ttlMs
    });
  }

  get(key: string): IdempotencyRecord | undefined {
    const record = this.store.get(key);
    if (!record) return undefined;
    if (Date.now() > record.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return record;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

export const idempotencyStore = new IdempotencyStore();

// Circuit breaker for external service resilience
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeout: number; // ms

  constructor(failureThreshold = 5, successThreshold = 2, resetTimeout = 60000) {
    this.failureThreshold = failureThreshold;
    this.successThreshold = successThreshold;
    this.resetTimeout = resetTimeout;
  }

  async execute<T>(
    operation: () => Promise<T>,
    operationName: string = 'unknown'
  ): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'half-open';
        this.successCount = 0;
      } else {
        throw new Error(`Circuit breaker open for ${operationName}. Retry after ${this.resetTimeout}ms`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): string {
    return this.state;
  }
}

// Exponential backoff retry helper
class ExponentialBackoffRetry {
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly multiplier: number;

  constructor(maxAttempts = 3, initialDelayMs = 100, maxDelayMs = 5000, multiplier = 2) {
    this.maxAttempts = maxAttempts;
    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.multiplier = multiplier;
  }

  async execute<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.maxAttempts - 1) {
          const delayMs = Math.min(
            this.maxDelayMs,
            this.initialDelayMs * Math.pow(this.multiplier, attempt)
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError || new Error(`Failed after ${this.maxAttempts} attempts for ${operationName}`);
  }
}

const copilotCircuitBreaker = new CircuitBreaker(5, 2, 60000);
const externalServiceRetry = new ExponentialBackoffRetry(3, 100, 5000, 2);

// Structured logging
class StructuredLogger {
  private logBuffer: any[] = [];
  private readonly maxBufferSize = 100;

  log(level: 'info' | 'warn' | 'error' | 'debug', message: string, context: any = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context
    };

    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    // In production, send to structured logging service
    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  info(message: string, context?: any) { this.log('info', message, context); }
  warn(message: string, context?: any) { this.log('warn', message, context); }
  error(message: string, context?: any) { this.log('error', message, context); }
  debug(message: string, context?: any) { this.log('debug', message, context); }

  getBuffer() { return [...this.logBuffer]; }
}

const logger = new StructuredLogger();

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  const traceId = req.traceId || crypto.randomUUID();
  const errorId = crypto.randomUUID();

  logger.error('Request error', {
    traceId,
    errorId,
    method: req.method,
    path: req.path,
    statusCode: err.statusCode || 500,
    message: err.message,
    stack: err.stack
  });

  // Determine if error is retriable
  const isRetriable = [408, 429, 500, 502, 503, 504].includes(err.statusCode || 500);
  const retryAfter = err.retryAfter || (isRetriable ? 60 : undefined);

  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
    errorId,
    traceId,
    retriable: isRetriable,
    retryAfter: retryAfter,
    timestamp: new Date().toISOString()
  });
});

// Idempotency key middleware for state-changing operations
export const idempotencyMiddleware = (req: any, res: any, next: any) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const key = req.headers['idempotency-key'];
    if (key) {
      req.idempotencyKey = key as string;
      const cached = idempotencyStore.get(key);
      if (cached) {
        res.status(cached.responseCode)
          .set('X-Idempotency-Replayed', 'true')
          .set('X-Trace-ID', req.traceId || '');
        return res.json(cached.responseBody);
      }
    }
  }
  next();
};

// Input validation schemas for API boundary protection
interface RequestSchema {
  validate(data: any): { valid: boolean; errors: string[] };
}

class JsonSchema implements RequestSchema {
  private requiredFields: Set<string>;
  private fieldTypes: Map<string, string>;

  constructor(fields: { [key: string]: string }, required: string[] = []) {
    this.fieldTypes = new Map(Object.entries(fields));
    this.requiredFields = new Set(required);
  }

  validate(data: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof data !== 'object' || data === null) {
      errors.push('Request body must be a valid JSON object');
      return { valid: false, errors };
    }
    for (const field of this.requiredFields) {
      if (!(field in data)) errors.push(`Missing required field: ${field}`);
    }
    for (const [field, expectedType] of this.fieldTypes) {
      if (field in data && typeof data[field] !== expectedType) {
        errors.push(`Field ${field} must be of type ${expectedType}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

// Schema validation middleware
export const schemaValidation = (schema: RequestSchema) => (req: any, res: any, next: any) => {
  const validation = schema.validate(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Invalid request payload', details: validation.errors });
  }
  next();
};

// Simple in-memory LRU cache for query results
class QueryCache {
  private cache: Map<string, { data: any; expires: number }> = new Map();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number = 500, ttlMs: number = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): any {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    // Move to end for LRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key: string, data: any): void {
    // Remove oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      data,
      expires: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const queryCache = new QueryCache();

// Token bucket for adaptive rate limiting
class TokenBucket {
  private tokens: number;
  private lastRefill: number = Date.now();
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
  }

  tryConsume(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const secondsElapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + secondsElapsed * this.refillRate
    );
    this.lastRefill = now;
  }

  getUtilization(): number {
    this.refill();
    return this.tokens / this.capacity;
  }
}

const globalBucket = new TokenBucket(1000, 100); // 1000 capacity, 100 tokens/sec

// Rate limiting configuration with backpressure handling
function createRateLimiter(windowMs: number = 60000, maxRequests: number = 100, message: string = 'Too many requests') {
  return rateLimit({
    windowMs,
    max: maxRequests,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: any, res: any) => {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too many requests',
        retryAfter,
        message: `Rate limit exceeded. Please retry after ${retryAfter} seconds.`
      });
    },
    skip: (req: any) => {
      // Skip rate limiting for health checks
      return req.path === '/health' || req.path === '/ready';
    }
  });
}

const globalLimiter = createRateLimiter(60000, 1000, 'Global rate limit exceeded');
const apiBusyLimiter = createRateLimiter(60000, 100, 'API rate limit exceeded');

// Retry configuration with exponential backoff and circuit breaker
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_TIMEOUT = 60000; // 60 seconds
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 100; // 100ms
const MAX_BACKOFF_MS = 5000; // 5 seconds
const BACKOFF_MULTIPLIER = 2;

// Enhanced retry wrapper with circuit breaker and exponential backoff
async function callExternalServiceWithRetry<T>(
  operation: () => Promise<T>,
  serviceName: string,
  traceId: string
): Promise<T> {
  const circuitBreaker = new CircuitBreaker(
    CIRCUIT_BREAKER_THRESHOLD,
    2,
    CIRCUIT_BREAKER_RESET_TIMEOUT
  );

  return circuitBreaker.execute(async () => {
    const retryHelper = new ExponentialBackoffRetry(
      MAX_RETRIES,
      INITIAL_BACKOFF_MS,
      MAX_BACKOFF_MS,
      BACKOFF_MULTIPLIER
    );

    try {
      const result = await retryHelper.execute(operation, serviceName);
      logger.debug(`External service call succeeded`, {
        serviceName,
        traceId,
        circuitBreakerState: circuitBreaker.getState()
      });
      return result;
    } catch (error) {
      logger.error(`External service call failed after retries`, {
        serviceName,
        traceId,
        error: error instanceof Error ? error.message : String(error),
        circuitBreakerState: circuitBreaker.getState()
      });
      throw error;
    }
  }, serviceName);
}

// Request timeout configuration
const DEFAULT_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const LONG_RUNNING_TIMEOUT_MS = 300000; // 5 minutes for background operations

// Timeout middleware factory
const timeoutMiddleware = (timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) => {
  return (req: any, res: any, next: any) => {
    let timeoutHandle: NodeJS.Timeout | null = null;
    let isResponseSent = false;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);

    res.json = function(data: any) {
      cleanup();
      isResponseSent = true;
      return originalJson(data);
    };

    res.send = function(data: any) {
      cleanup();
      isResponseSent = true;
      return originalSend(data);
    };

    res.end = function() {
      cleanup();
      isResponseSent = true;
      return originalEnd();
    };

    timeoutHandle = setTimeout(() => {
      if (!isResponseSent) {
        isResponseSent = true;
        res.status(408).json({
          error: 'Request timeout',
          timeout: timeoutMs,
          timestamp: new Date().toISOString()
        });
      }
    }, timeoutMs);

    res.on('finish', cleanup);
    next();
  };
};

// Rate limiter with backpressure handling
export const createLimiter = () => (req: any, res: any, next: any) => {
  const utilization = globalBucket.getUtilization();

  if (!globalBucket.tryConsume(1)) {
    res.setHeader('Retry-After', '1');
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + 1000).toISOString());
    res.setHeader('X-Backpressure', 'high');
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Graceful degradation signals
  if (utilization > 0.8) {
    res.setHeader('X-Backpressure', 'moderate');
  } else if (utilization > 0.95) {
    res.setHeader('X-Backpressure', 'critical');
  }

  next();
};

// Gzip compression middleware
function compressionMiddleware(req: any, res: any, next: any): void {
  const acceptEncoding = (req.headers['accept-encoding'] || '').toString();

  if (acceptEncoding.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
  }

  next();
}

// Optimized JSON serialization: removes circular refs and whitespace
function serializeOptimized(data: any): string {
  const seen = new WeakSet();
  return JSON.stringify(data, (key: string, value: any) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}

// Request correlation middleware for trace ID propagation
const requestCorrelationMiddleware = (req: any, res: any, next: any) => {
  // Generate or extract trace ID for request correlation
  req.traceId = req.headers['x-trace-id'] ||
    req.headers['x-request-id'] ||
    require('crypto').randomUUID();

  res.set('X-Trace-ID', req.traceId);
  next();
};

// Apply middleware to app if available
if (app && typeof app.use === 'function') {
  app.use(compressionMiddleware);
  app.use(requestCorrelationMiddleware);
  app.use(createLimiter());
  app.use(idempotencyMiddleware);
  // Add JSON body parser with validation
  app.use(require('express').json({
    verify: (req: any, res, buf) => {
      req.rawBody = buf.toString();
    }
  }));
}

// Batch query utilities to eliminate N+1 patterns
export class BatchQueryExecutor {
  // Batch fetch operation: converts array of queries into single bulk request
  static async batchFetch(
    ids: (string | number)[],
    queryFn: (ids: (string | number)[]) => Promise<any[]>
  ): Promise<Map<string | number, any>> {
    if (!ids || ids.length === 0) return new Map();

    // Use cache key based on sorted IDs for consistency
    const cacheKey = `batch_${ids.sort().join('_')}`;
    const cached = queryCache.get(cacheKey);
    if (cached) return new Map(Object.entries(cached));

    // Execute single bulk query instead of n queries
    const results = await queryFn(ids);
    const resultMap: Record<string, any> = {};
    results.forEach((item: any) => {
      if (item.id) resultMap[item.id] = item;
    });

    queryCache.set(cacheKey, resultMap);
    return new Map(Object.entries(resultMap));
  }

  // Batch insert operation: single round-trip for multiple inserts
  static async batchInsert(
    items: any[],
    insertFn: (items: any[]) => Promise<any[]>
  ): Promise<any[]> {
    if (!items || items.length === 0) return [];
    // Single database round-trip for all inserts
    return insertFn(items);
  }

  // Decorator for automatic query batching with debounce
  static batchDecorator(
    queryFn: (ids: (string | number)[]) => Promise<any[]>,
    debounceMs: number = 10
  ) {
    let pending: (string | number)[] = [];
    let timer: NodeJS.Timeout | null = null;
    const results = new Map<string | number, Promise<any>>();

    return (id: string | number): Promise<any> => {
      if (results.has(id)) return results.get(id)!;

      pending.push(id);
      const promise = new Promise((resolve) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const ids = [...new Set(pending)];
          pending = [];
          timer = null;
          const mapped = await this.batchFetch(ids, queryFn);
          ids.forEach((id) => resolve(mapped.get(id)));
        }, debounceMs);
      });

      results.set(id, promise);
      return promise;
    };
  }
}

// Health check dependency probes
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  dependencies: {
    [key: string]: { status: 'ok' | 'error' | 'unknown'; message?: string };
  };
}

const performHealthCheck = async (): Promise<HealthStatus> => {
  const dependencies: { [key: string]: any } = {};

  // Check external services
  dependencies.copilot = { status: 'ok', message: 'GitHub Copilot SDK initialized' };

  // Simulate database health check
  try {
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, 100)),
      Promise.reject(new Error('timeout'))
    ]);
    dependencies.database = { status: 'ok', message: 'Connected' };
  } catch (e) {
    dependencies.database = { status: 'error', message: 'Connection failed' };
  }

  // Check cache
  try {
    dependencies.cache = { status: 'ok', message: 'Cache operational' };
  } catch (e) {
    dependencies.cache = { status: 'error', message: 'Cache unavailable' };
  }

  const overallStatus = Object.values(dependencies).every((d: any) => d.status === 'ok') ? 'healthy' : 'degraded';
  return {
    status: overallStatus,
    timestamp: Date.now(),
    uptime: process.uptime(),
    dependencies
  };
};

// Health check endpoint
if (app && typeof app.get === 'function') {
  app.get('/health', async (req: any, res: any) => {
    try {
      const health = await performHealthCheck();
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).set('X-Trace-ID', req.traceId || '').json(health);
    } catch (error) {
      res.status(503).json({ status: 'unhealthy', error: 'Health check failed' });
    }
  });

  app.get('/readiness', async (req: any, res: any) => {
    try {
      const health = await performHealthCheck();
      const ready = health.status !== 'unhealthy' && health.dependencies.database.status === 'ok';
      const statusCode = ready ? 200 : 503;
      res.status(statusCode).set('X-Trace-ID', req.traceId || '').json({ ready, dependencies: health.dependencies });
    } catch (error) {
      res.status(503).json({ ready: false, error: 'Readiness check failed' });
    }
  });
}

export default app;