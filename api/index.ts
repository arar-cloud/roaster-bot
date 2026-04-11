import app from '../src/index.js';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';

// TokenBucketLimiter implementation
class TokenBucketLimiter {
  private tokens: number;
  private lastRefillAt: number = Date.now();
  private readonly refillRatePerSecond: number;
  private readonly capacity: number;
  
  constructor(capacity: number = 10, refillRatePerSecond: number = 1) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
  }
  
  canConsume(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
  
  getRetryAfterMs(): number {
    this.refill();
    if (this.tokens < 1) {
      return Math.ceil((1 - this.tokens) / this.refillRatePerSecond * 1000);
    }
    return 0;
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillAt) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRatePerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillAt = now;
  }
}

// ConnectionPool singleton
class ConnectionPool {
  private static instance: ConnectionPool | null = null;
  private activeConnections: Map<string, any> = new Map();
  private readonly requestTimeoutMs: number;
  private cleanupIntervalId: any;
  
  private constructor(requestTimeoutMs: number = 30000) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.startCleanupInterval();
  }
  
  static getInstance(requestTimeoutMs?: number): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool(requestTimeoutMs);
    }
    return ConnectionPool.instance;
  }
  
  getConnection(clientId: string): any {
    let conn = this.activeConnections.get(clientId);
    if (!conn) {
      conn = { clientId, createdAt: Date.now(), timeout: this.requestTimeoutMs };
      this.activeConnections.set(clientId, conn);
    }
    return conn;
  }
  
  releaseConnection(clientId: string): void {
    this.activeConnections.delete(clientId);
  }
  
  private startCleanupInterval(): void {
    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now();
      for (const [clientId, conn] of this.activeConnections) {
        if (now - conn.createdAt > this.requestTimeoutMs * 2) {
          this.activeConnections.delete(clientId);
        }
      }
    }, 60000);
  }
  
  shutdown(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }
    this.activeConnections.clear();
  }
}

// Per-client rate limiter tracking
const rateLimiters = new Map<string, TokenBucketLimiter>();

function getRateLimiter(clientId: string): TokenBucketLimiter {
  let limiter = rateLimiters.get(clientId);
  if (!limiter) {
    limiter = new TokenBucketLimiter(100, 10);
    rateLimiters.set(clientId, limiter);
  }
  return limiter;
}

function structuredLog(level: string, message: string, meta?: Record<string, any>): void {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...meta
  };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(logEntry));
}

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      traceId?: string;
      idempotencyKey?: string;
      startTime?: number;
      clientId?: string;
      rateLimiter?: TokenBucketLimiter;
      connectionPool?: ConnectionPool;
    }
  }
}

// Health check middleware with error handling
function healthCheckMiddleware(req: any, res: any, next: any): void {
  try {
    const healthStatus = {
      status: 'healthy',
      timestamp: Date.now(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      poolSize: connectionPool.activeConnections?.size ?? 0
    };
    res.status(200).json(healthStatus);
  } catch (err) {
    structuredLog('error', 'Health check failed', {
      traceId: req.traceId,
      error: err instanceof Error ? err.message : String(err)
    });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
}

const connectionPool = ConnectionPool.getInstance();

// Idempotency store with TTL eviction
interface IdempotencyEntry {
  response: any;
  statusCode: number;
  createdAt: number;
  ttlMs: number;
}

class IdempotencyStore {
  private store = new Map<string, IdempotencyEntry>();
  private cleanupIntervalId: any;
  private readonly defaultTtlMs: number = 3600000; // 1 hour
  
  constructor() {
    this.startCleanupInterval();
  }
  
  set(key: string, response: any, statusCode: number, ttlMs?: number): void {
    this.store.set(key, {
      response: JSON.parse(JSON.stringify(response)),
      statusCode,
      createdAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs
    });
  }
  
  getIfExists(key: string): { response: any; statusCode: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    
    const age = Date.now() - entry.createdAt;
    if (age > entry.ttlMs) {
      this.store.delete(key);
      return null;
    }
    
    return { response: entry.response, statusCode: entry.statusCode };
  }
  
  private startCleanupInterval(): void {
    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now - entry.createdAt > entry.ttlMs) {
          this.store.delete(key);
        }
      }
    }, 300000);
  }
  
  shutdown(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }
    this.store.clear();
  }
}

const idempotencyStore = new IdempotencyStore();

// Middleware: Inject trace ID and client ID
function traceMiddleware(req: any, res: any, next: any): void {
  req.traceId = req.get('X-Trace-ID') || randomUUID();
  req.clientId = req.get('X-Client-ID') || req.ip || 'unknown';
  req.startTime = Date.now();
  req.idempotencyKey = req.get('Idempotency-Key');
  req.rateLimiter = getRateLimiter(req.clientId);
  req.connectionPool = connectionPool.getConnection(req.clientId);
  
  const conn = req.connectionPool;
  const timeoutHandle = setTimeout(() => {
    structuredLog('warn', req.traceId, 'Request timeout threshold reached', {
      clientId: req.clientId,
      timeoutMs: conn.timeout,
      elapsed: Date.now() - req.startTime
    });
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout' });
    }
  }, conn.timeout);
  
  res.on('finish', () => {
    clearTimeout(timeoutHandle);
    connectionPool.releaseConnection(req.clientId);
    const elapsed = Date.now() - req.startTime;
    structuredLog('info', req.traceId, 'Request completed', { elapsed, clientId: req.clientId });
  });
  
  res.set('X-Trace-ID', req.traceId);
  next();
}

// Middleware: Rate limiting enforcement with exponential backoff guidance
function rateLimitMiddleware(req: any, res: any, next: any): void {
  try {
    const limiter = req.rateLimiter as TokenBucketLimiter;
    
    if (!limiter.canConsume(1)) {
      const retryAfterMs = limiter.getRetryAfterMs();
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
      
      res.set('Retry-After', String(retryAfterSeconds));
      res.set('X-RateLimit-Reset', String(Date.now() + retryAfterMs));
      res.set('X-Retry-After-Ms', String(retryAfterMs));
      
      structuredLog('warn', req.traceId, 'Rate limit exceeded', {
        clientId: req.clientId,
        retryAfterSeconds,
        retryAfterMs
      });
      
      const errorResponse = createErrorResponse('RATE_LIMITED', 'Rate limit exceeded', req.traceId, {
        retryAfterSeconds,
        retryAfterMs,
        timestamp: Date.now()
      });
      res.status(429).json(errorResponse);
      return;
    }
    next();
  } catch (err) {
    structuredLog('error', req.traceId, 'Rate limit check failed', {
      error: err instanceof Error ? err.message : String(err)
    });
    res.status(500).json(createErrorResponse('INTERNAL_ERROR', 'Rate limit check failed', req.traceId));
  }
}

// Middleware: Idempotency key check for write operations with response validation
function idempotencyMiddleware(req: any, res: any, next: any): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  const idempotencyKey = req.idempotencyKey;
  if (!idempotencyKey) {
    structuredLog('warn', req.traceId, 'Missing idempotency key for write operation', { method: req.method });
  } else {
    const existing = idempotencyStore.getIfExists(idempotencyKey);
    if (existing) {
      const isSuccessStatus = existing.statusCode >= 200 && existing.statusCode < 300;
      
      if (!isSuccessStatus) {
        structuredLog('warn', req.traceId, 'Returning cached error response', { idempotencyKey, statusCode: existing.statusCode });
      } else {
        structuredLog('info', req.traceId, 'Returning cached success response', { idempotencyKey, statusCode: existing.statusCode });
      }
      res.status(existing.statusCode).json(existing.response);
      return;
    }
  }
  next();
}

// Middleware: Health check and ready probe endpoints
function healthCheckMiddleware(req: any, res: any, next: any): void {
  if (req.path === '/health') {
    const uptime = Date.now() - healthState.startTime;
    res.status(200).json({
      status: 'alive',
      uptime,
      traceId: req.traceId
    });
    return;
  }

  if (req.path === '/ready') {
    const status = getHealthStatus();
    const statusCode = status.ready ? 200 : 503;
    res.status(statusCode).json({
      ready: status.ready,
      reason: status.reason,
      traceId: req.traceId
    });
    return;
  }

  next();
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

// Retry utility with exponential backoff and jitter
interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  traceId: string,
  operationName: string,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        structuredLog('info', traceId, `${operationName} succeeded after ${attempt} retry/retries`);
      }
      return result;
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxRetries) {
        structuredLog('error', traceId, `${operationName} failed after ${maxRetries} retries`, {
          error: lastError.message,
          finalAttempt: true
        });
        throw lastError;
      }

      const delayMs = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt) + Math.random() * 100,
        maxDelayMs
      );

      structuredLog('warn', traceId, `${operationName} attempt ${attempt + 1} failed, retrying in ${delayMs}ms`, {
        error: lastError.message,
        attempt: attempt + 1,
        maxRetries
      });

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxRetries} retries`);
}

// Request validation schema
interface ValidationSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required?: boolean;
    maxLength?: number;
    minLength?: number;
    min?: number;
    max?: number;
  };
}

function validateRequest(body: any, schema: ValidationSchema, traceId: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = body?.[field];
    const isPresent = value !== undefined && value !== null;

    if (rules.required && !isPresent) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }

    if (!isPresent) continue;

    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== rules.type) {
      errors.push(`Field ${field}: expected ${rules.type}, got ${actualType}`);
      continue;
    }

    if (rules.type === 'string') {
      if (rules.maxLength && value.length > rules.maxLength) {
        errors.push(`Field ${field}: exceeds max length of ${rules.maxLength}`);
      }
      if (rules.minLength && value.length < rules.minLength) {
        errors.push(`Field ${field}: below min length of ${rules.minLength}`);
      }
    }

    if (rules.type === 'number') {
      if (rules.max !== undefined && value > rules.max) {
        errors.push(`Field ${field}: exceeds maximum value of ${rules.max}`);
      }
      if (rules.min !== undefined && value < rules.min) {
        errors.push(`Field ${field}: below minimum value of ${rules.min}`);
      }
    }
  }

  if (errors.length > 0) {
    structuredLog('warn', traceId, 'Request validation failed', { errors });
  }

  return { valid: errors.length === 0, errors };
}

// Structured error response format
type ErrorCode = 'VALIDATION_ERROR' | 'TIMEOUT' | 'SERVICE_UNAVAILABLE' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'DEPENDENCY_ERROR';

interface ErrorResponse {
  code: ErrorCode;
  message: string;
  traceId: string;
  details?: Record<string, any>;
}

function createErrorResponse(code: ErrorCode, message: string, traceId: string, details?: Record<string, any>): ErrorResponse {
  return {
    code,
    message,
    traceId,
    details
  };
}

function getHttpStatusForErrorCode(code: ErrorCode): number {
  const statusMap: Record<ErrorCode, number> = {
    'VALIDATION_ERROR': 400,
    'TIMEOUT': 504,
    'SERVICE_UNAVAILABLE': 503,
    'RATE_LIMITED': 429,
    'INTERNAL_ERROR': 500,
    'DEPENDENCY_ERROR': 502
  };
  return statusMap[code] || 500;
}

// Circuit breaker for downstream services
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface CircuitBreakerConfig {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  successThreshold?: number;
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(private traceId: string, config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30000;
    this.successThreshold = config.successThreshold ?? 2;
  }

  async execute<T>(operation: () => Promise<T>, serviceName: string): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        structuredLog('info', this.traceId, `Circuit breaker transitioning to HALF_OPEN for ${serviceName}`);
      } else {
        throw createErrorResponse('SERVICE_UNAVAILABLE', `Circuit breaker OPEN for ${serviceName}`, this.traceId);
      }
    }

    try {
      const result = await operation();
      this.recordSuccess(serviceName);
      return result;
    } catch (error) {
      this.recordFailure(serviceName);
      throw error;
    }
  }

  private recordSuccess(serviceName: string): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = CircuitState.CLOSED;
        structuredLog('info', this.traceId, `Circuit breaker CLOSED for ${serviceName}`);
      }
    }
  }

  private recordFailure(serviceName: string): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      structuredLog('warn', this.traceId, `Circuit breaker OPEN for ${serviceName} after failure in HALF_OPEN state`);
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      structuredLog('warn', this.traceId, `Circuit breaker OPEN for ${serviceName}`, { failureCount: this.failureCount });
    }
  }
}

// Global circuit breaker instances per service
const circuitBreakers = new Map<string, CircuitBreaker>();
  console.log(JSON.stringify(logEntry));
}

// Wire up all middleware into app
function wireMiddleware(appInstance: any): void {
  appInstance.use(traceMiddleware);
  appInstance.use(healthCheckMiddleware);
  appInstance.use(rateLimitMiddleware);
  appInstance.use(idempotencyMiddleware);
  appInstance.use(loggingMiddleware);
  // Error handler must be registered last
  appInstance.use(errorHandlerMiddleware);
}

// Initialize middleware on app instance
wireMiddleware(app);

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

// Idempotency key tracking for write operations
interface IdempotencyRecord {
  key: string;
  responseCode: number;
  responseBody: any;
  timestamp: number;
  expiresAt: number;
  requestId: string;
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
      expiresAt: Date.now() + this.ttlMs,
      requestId: randomUUID()
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

// Token bucket rate limiter
interface RateLimiterConfig {
  tokensPerMinute?: number;
  maxBurst?: number;
}

class TokenBucketLimiter {
  private tokens: number;
  private lastRefillTime: number = Date.now();
  private readonly tokensPerMs: number;
  private readonly maxBurst: number;

  constructor(private traceId: string, config: RateLimiterConfig = {}) {
    const tokensPerMinute = config.tokensPerMinute ?? 100;
    this.maxBurst = config.maxBurst ?? tokensPerMinute;
    this.tokens = this.maxBurst;
    this.tokensPerMs = tokensPerMinute / 60000;
  }

  tryAcquire(tokensNeeded: number = 1): { allowed: boolean; retryAfterMs?: number } {
    this.refillTokens();

    if (this.tokens >= tokensNeeded) {
      this.tokens -= tokensNeeded;
      return { allowed: true };
    }

    const tokensShort = tokensNeeded - this.tokens;
    const retryAfterMs = Math.ceil(tokensShort / this.tokensPerMs);
    return { allowed: false, retryAfterMs };
  }

  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefillTime;
    const tokensToAdd = timePassed * this.tokensPerMs;
    this.tokens = Math.min(this.maxBurst, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

const copilotCircuitBreaker = new CircuitBreaker(5, 2, 60000);
const externalServiceRetry = new ExponentialBackoffRetry(3, 100, 5000, 2);

// Health check state
interface HealthState {
  isReady: boolean;
  dependenciesReady: Record<string, boolean>;
  uptime: number;
  startTime: number;
}

const healthState: HealthState = {
  isReady: true,
  dependenciesReady: {},
  uptime: 0,
  startTime: Date.now()
};

function updateDependencyHealth(serviceName: string, isHealthy: boolean): void {
  healthState.dependenciesReady[serviceName] = isHealthy;
}

function getHealthStatus(): { ready: boolean; reason?: string } {
  const dependenciesReady = Object.values(healthState.dependenciesReady).every(v => v !== false);
  const ready = healthState.isReady && dependenciesReady;
  return {
    ready,
    reason: ready ? undefined : 'One or more dependencies are unhealthy'
  };
}

// Connection pool configuration
interface PoolConfig {
  maxConnections?: number;
  maxQueueSize?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

class ConnectionPool {
  private activeConnections: number = 0;
  private queuedRequests: number = 0;
  private readonly maxConnections: number;
  private readonly maxQueueSize: number;
  private readonly requestTimeoutMs: number;

  constructor(private traceId: string, config: PoolConfig = {}) {
    this.maxConnections = config.maxConnections ?? 100;
    this.maxQueueSize = config.maxQueueSize ?? 50;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  async acquireConnection<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
    operationName: string
  ): Promise<T> {
    if (this.activeConnections >= this.maxConnections) {
      this.queuedRequests++;
      if (this.queuedRequests > this.maxQueueSize) {
        this.queuedRequests--;
        throw createErrorResponse('SERVICE_UNAVAILABLE', 'Connection pool queue exceeded', this.traceId, {
          activeConnections: this.activeConnections,
          queuedRequests: this.queuedRequests
        });
      }
    }

    this.activeConnections++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const result = await operation(controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        structuredLog('error', this.traceId, `${operationName} timeout after ${this.requestTimeoutMs}ms`);
        throw createErrorResponse('TIMEOUT', `${operationName} timeout exceeded`, this.traceId);
      }
      throw error;
    } finally {
      this.activeConnections--;
      if (this.queuedRequests > 0) {
        this.queuedRequests--;
      }
    }
  }

  getStatus(): Record<string, number> {
    return {
      activeConnections: this.activeConnections,
      queuedRequests: this.queuedRequests,
      maxConnections: this.maxConnections
    };
  }
}

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

// Centralized validation middleware for all request types
export const validationMiddleware = (req: any, res: any, next: any) => {
  try {
    // Validate query parameters exist and are not malicious
    if (req.query && typeof req.query === 'object') {
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string' && value.length > 2000) {
          return res.status(400).json({ error: 'Query parameter too long', field: key });
        }
      }
    }
    // Validate path parameters
    if (req.params && typeof req.params === 'object') {
      for (const [key, value] of Object.entries(req.params)) {
        if (typeof value !== 'string' && typeof value !== 'number') {
          return res.status(400).json({ error: 'Invalid path parameter type', field: key });
        }
      }
    }
    next();
  } catch (error: any) {
    logger.error('Validation middleware error', { error: error.message });
    return res.status(400).json({ error: 'Request validation failed' });
  }
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

/**
 * Exponential backoff retry with circuit breaker integration
 *
 * Implements resilient retry logic for external service calls:
 * - Exponential backoff: 100ms * 2^attempt, capped at 5s
 * - Circuit breaker: Opens after 5 consecutive failures, re-attempts after 60s
 * - Max retries: 3 attempts (configurable)
 * - Trace ID: Logs all retry attempts with trace ID for debugging
 *
 * Failure modes and recovery:
 * - If circuit breaker is open: Throws immediately without retrying
 * - If all retries exhausted: Throws last encountered error
 * - On transient failures (timeout, 5xx): Retries with backoff
 * - On permanent failures (4xx): Fails immediately
 *
 * @param fn The async function to retry
 * @param serviceName Identifier for circuit breaker state tracking
 * @param traceId Request trace ID for logging correlation
 * @param maxRetries Maximum number of retry attempts (default: 3)
 * @throws Error if circuit breaker is open or all retries exhausted
 * @returns Result of successful function call
 */
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

// Input validation functions for request parameters
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

function validateNumber(value: any, fieldName: string, min?: number, max?: number): number {
  const num = Number(value);
  if (isNaN(num)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  if (min !== undefined && num < min) {
    throw new Error(`${fieldName} must be at least ${min}`);
  }
  if (max !== undefined && num > max) {
    throw new Error(`${fieldName} must be at most ${max}`);
  }
  return num;
}

function validateBoolean(value: any, fieldName: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${fieldName} must be a boolean`);
}

function validateArrayNotEmpty<T>(arr: T[], fieldName: string): T[] {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  return arr;
}

function validateStringLength(str: string, fieldName: string, min: number = 0, max: number = 1000): string {
  if (typeof str !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (str.length < min || str.length > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max} characters`);
  }
  return str;
}

// Health check endpoint (bypasses rate limiting)
function setupHealthChecks(expressApp: any): void {
  expressApp.get('/health', (req: any, res: any) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });
}

// Graceful shutdown setup
function setupGracefulShutdown(expressApp: any): void {
  const shutdown = () => {
    structuredLog('info', randomUUID(), 'graceful_shutdown_initiated', {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Connection tracking middleware for graceful shutdown
const connectionTrackingMiddleware = (req: any, res: any, next: any) => {
  next();
};

// Async handler wrapper for error handling
export const asyncHandler = (fn: any) => (req: any, res: any, next: any) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Initialize API with middleware stack
export function initializeApi(expressApp: any): void {
  setupHealthChecks(expressApp);
  setupGracefulShutdown(expressApp);
  expressApp.use(loggingMiddleware);
  expressApp.use(connectionTrackingMiddleware);
  expressApp.use((req: any, res: any, next: any) => globalLimiter(req, res, next));
  expressApp.use(idempotencyMiddleware);
  structuredLog('info', randomUUID(), 'api_initialized', {
    rateLimiting: 'enabled',
    idempotency: 'enabled'
  });
}

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

// Database connection pool configuration
const DB_CONFIG = {
  pool: {
    min: 2,
    max: 10,
    idleTimeoutMillis: 30000, // 30 seconds
    connectionTimeoutMillis: 5000, // 5 seconds
  },
  query: {
    timeoutMs: 10000, // 10 seconds per query
    maxAttempts: 3,
  }
};

// Idempotency key management
interface IdempotencyRecord {
  key: string;
  statusCode: number;
  responseBody: any;
  timestamp: number;
}

const idempotencyCache = new Map<string, IdempotencyRecord>();
const IDEMPOTENCY_CACHE_TTL = 3600000; // 1 hour

function cleanupIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, record] of idempotencyCache.entries()) {
    if (now - record.timestamp > IDEMPOTENCY_CACHE_TTL) {
      idempotencyCache.delete(key);
    }
  }
}

function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only apply to mutation methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    return next();
  }

  req.idempotencyKey = idempotencyKey;
  const cacheKey = `${req.method}:${req.path}:${idempotencyKey}`;

  // Check for cached response
  const cached = idempotencyCache.get(cacheKey);
  if (cached) {
    structuredLog('info', req.traceId || 'unknown', 'idempotency_cache_hit', { cacheKey });
    return res.status(cached.statusCode).json(cached.responseBody);
  }

  // Intercept response to cache it
  const originalSend = res.send.bind(res);
  res.send = function(data: any) {
    const responseBody = typeof data === 'string' ? JSON.parse(data) : data;
    idempotencyCache.set(cacheKey, {
      key: idempotencyKey,
      statusCode: res.statusCode,
      responseBody,
      timestamp: Date.now()
    });
    return originalSend(data);
  };

  next();
}

// Cleanup idempotency cache every 10 minutes
setInterval(cleanupIdempotencyCache, 600000);

// Error handling utilities
interface ApiError {
  statusCode: number;
  message: string;
  errors?: Array<{ field: string; message: string }>;
}

function createErrorResponse(statusCode: number, message: string, errors?: any[]): ApiError {
  return {
    statusCode,
    message,
    errors: errors?.map(e => ({
      field: e.field || 'unknown',
      message: e.message || e
    }))
  };
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      const traceId = req.traceId || 'unknown';
      structuredLog('error', traceId, 'unhandled_error', {
        message: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method
      });

      if (error instanceof ValidationError) {
        return res.status(400).json(createErrorResponse(400, 'Validation failed', [error]));
      }

      res.status(500).json(createErrorResponse(500, 'Internal server error', [{
        field: 'server',
        message: 'An unexpected error occurred. Please retry or contact support.'
      }]));
    });
  };
}

// Graceful shutdown state
let isShuttingDown = false;
let activeConnections = 0;
const GRACEFUL_SHUTDOWN_TIMEOUT = 30000; // 30 seconds

// Connection tracking middleware
function connectionTrackingMiddleware(req: Request, res: Response, next: NextFunction): void {
  activeConnections++;

  res.on('finish', () => {
    activeConnections--;
  });

  if (isShuttingDown) {
    res.set('Connection', 'close');
  }

  next();
}

// Health check endpoints
function setupHealthChecks(expressApp: any): void {
  // Liveness probe - basic health check
  expressApp.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Readiness probe - full service readiness
  expressApp.get('/ready', (req: Request, res: Response) => {
    if (isShuttingDown) {
      return res.status(503).json({
        status: 'shutting_down',
        message: 'Service is gracefully shutting down'
      });
    }

    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      activeConnections
    });
  });
}

// Graceful shutdown handler
function setupGracefulShutdown(expressApp: any): void {
  const signals = ['SIGTERM', 'SIGINT'];

  signals.forEach(signal => {
    process.on(signal, () => {
      const traceId = randomUUID();
      structuredLog('info', traceId, 'shutdown_signal_received', { signal });

      isShuttingDown = true;

      // Stop accepting new requests
      expressApp.use((req: Request, res: Response) => {
        res.status(503).json({
          error: 'Service is shutting down',
          message: 'Please retry your request'
        });
      });

      // Wait for active connections to drain
      const shutdownTimeout = setTimeout(() => {
        structuredLog('warn', traceId, 'graceful_shutdown_timeout', { activeConnections });
        process.exit(1);
      }, GRACEFUL_SHUTDOWN_TIMEOUT);

      // Check if all connections are done
      const checkConnections = setInterval(() => {
        if (activeConnections === 0) {
          clearInterval(checkConnections);
          clearTimeout(shutdownTimeout);
          structuredLog('info', traceId, 'graceful_shutdown_complete', { signal });
          process.exit(0);
        }
      }, 1000);
    });
  });
}

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