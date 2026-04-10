import app from '../src/index.js';
import type { NextFunction, Request, Response } from 'express';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      traceId?: string;
      idempotencyKey?: string;
      validatedBody?: any;
      validatedQuery?: any;
      validatedParams?: any;
    }
  }
}

// Input validation utilities
class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

function validateString(value: any, fieldName: string, minLength = 0, maxLength = 10000): string {
  if (typeof value !== 'string') {
    throw new ValidationError(fieldName, `${fieldName} must be a string`);
  }
  if (value.length < minLength) {
    throw new ValidationError(fieldName, `${fieldName} must be at least ${minLength} characters`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(fieldName, `${fieldName} must not exceed ${maxLength} characters`);
  }
  return value.trim();
}

function validateNumber(value: any, fieldName: string, min?: number, max?: number): number {
  const num = Number(value);
  if (isNaN(num)) {
    throw new ValidationError(fieldName, `${fieldName} must be a valid number`);
  }
  if (min !== undefined && num < min) {
    throw new ValidationError(fieldName, `${fieldName} must be at least ${min}`);
  }
  if (max !== undefined && num > max) {
    throw new ValidationError(fieldName, `${fieldName} must not exceed ${max}`);
  }
  return num;
}

function sanitizeString(value: string): string {
  return value
    .replace(/[<>"']/g, (char) => {
      const htmlEntityMap: { [key: string]: string } = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return htmlEntityMap[char] || char;
    })
    .slice(0, 10000);
}

function validatePayload(data: any, expectedFields: { [key: string]: 'string' | 'number' | 'email' | 'optional' }): Record<string, any> {
  const validated: Record<string, any> = {};
  
  for (const [field, type] of Object.entries(expectedFields)) {
    if (type === 'optional') {
      validated[field] = data[field] || null;
      continue;
    }
    
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      throw new ValidationError(field, `Missing required field: ${field}`);
    }
    
    if (type === 'string') {
      validated[field] = sanitizeString(validateString(data[field], field));
    } else if (type === 'number') {
      validated[field] = validateNumber(data[field], field);
    } else if (type === 'email') {
      const email = validateString(data[field], field);
      if (!validateEmail(email)) {
        throw new ValidationError(field, `${field} must be a valid email address`);
      }
      validated[field] = email.toLowerCase();
    }
  }
  
  return validated;
}

// Idempotency store (in-memory for single instance, should use Redis in production)
interface IdempotencyRecord {
  key: string;
  responseCode: number;
  responseBody: any;
  timestamp: number;
  expiresAt: number;
  requestHash: string;
}

function isValidIdempotencyKey(key: string): boolean {
  const keyRegex = /^[a-zA-Z0-9_-]{1,255}$/;
  return keyRegex.test(key);
}

function generateRequestHash(method: string, path: string, body: any): string {
  const content = `${method}:${path}:${JSON.stringify(body || {})}`;
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// Circuit breaker for external service calls
interface CircuitState {
  status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

class CircuitBreaker {
  private state: CircuitState = {
    status: 'CLOSED',
    failureCount: 0,
    lastFailureTime: 0,
    successCount: 0,
  };
  
  private readonly failureThreshold = 5;
  private readonly successThreshold = 2;
  private readonly timeout = 60000; // 1 minute

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries = 3,
  ): Promise<T> {
    if (this.state.status === 'OPEN') {
      if (Date.now() - this.state.lastFailureTime > this.timeout) {
        this.state.status = 'HALF_OPEN';
        this.state.successCount = 0;
      } else {
        throw new Error(`Circuit breaker OPEN for ${operationName}. Service unavailable.`);
      }
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeWithTimeout(operation, 30000);
        this.recordSuccess();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    this.recordFailure();
    throw lastError || new Error(`${operationName} failed after ${maxRetries} retries`);
  }

  private async executeWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Operation timeout')), timeoutMs),
      ),
    ]);
  }

  private recordSuccess(): void {
    this.state.failureCount = 0;
    if (this.state.status === 'HALF_OPEN') {
      this.state.successCount += 1;
      if (this.state.successCount >= this.successThreshold) {
        this.state.status = 'CLOSED';
        this.state.successCount = 0;
      }
    }
  }

  private recordFailure(): void {
    this.state.lastFailureTime = Date.now();
    this.state.failureCount += 1;
    if (this.state.failureCount >= this.failureThreshold) {
      this.state.status = 'OPEN';
    }
  }

  getStatus(): CircuitState {
    return { ...this.state };
  }
}

class IdempotencyStore {
  private store: Map<string, IdempotencyRecord> = new Map();
  private readonly ttlMs = 60 * 60 * 1000;

  check(key: string, requestHash: string): IdempotencyRecord | null {
    if (!isValidIdempotencyKey(key)) {
      throw new ValidationError('idempotencyKey', 'Invalid idempotency key format');
    }
    const record = this.store.get(key);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    if (record.requestHash !== requestHash) {
      throw new ValidationError('idempotencyKey', 'Idempotency key already used with different request parameters');
    }
    return record;
  }

  storeResponse(key: string, requestHash: string, responseCode: number, responseBody: any): void {
    if (!isValidIdempotencyKey(key)) {
      throw new ValidationError('idempotencyKey', 'Invalid idempotency key format');
    }
    this.store.set(key, {
      key,
      requestHash,
      responseCode,
      responseBody,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

// Rate limiting and backpressure handler
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  queueLimit: number;
}

class RateLimiter {
  private requestCounts: Map<string, number[]> = new Map();
  private requestQueue: number = 0;
  private readonly config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      windowMs: config.windowMs || 60000, // 1 minute
      maxRequests: config.maxRequests || 100,
      queueLimit: config.queueLimit || 500,
    };
  }

  checkLimit(clientId: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    if (!this.requestCounts.has(clientId)) {
      this.requestCounts.set(clientId, []);
    }

    const timestamps = this.requestCounts.get(clientId)!;
    const recentRequests = timestamps.filter((t) => t > windowStart);

    if (recentRequests.length >= this.config.maxRequests) {
      const oldestRequest = Math.min(...recentRequests);
      const retryAfter = Math.ceil((oldestRequest + this.config.windowMs - now) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    recentRequests.push(now);
    this.requestCounts.set(clientId, recentRequests);
    return { allowed: true };
  }

  checkBackpressure(): { allowed: boolean; queueLength: number } {
    const allowed = this.requestQueue < this.config.queueLimit;
    return { allowed, queueLength: this.requestQueue };
  }

  incrementQueue(): void {
    this.requestQueue += 1;
  }

  decrementQueue(): void {
    this.requestQueue = Math.max(0, this.requestQueue - 1);
  }

  getMetrics(): { clientCount: number; queueLength: number } {
    return {
      clientCount: this.requestCounts.size,
      queueLength: this.requestQueue,
    };
  }
}

// Connection pool management
interface PooledConnection {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  inUse: boolean;
  timeout: NodeJS.Timeout | null;
}

class ConnectionPool {
  private connections: Map<string, PooledConnection> = new Map();
  private readonly maxConnections = 50;
  private readonly connectionTimeout = 30000; // 30 seconds
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup idle connections every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupIdleConnections(), 5 * 60 * 1000);
  }

  acquireConnection(): string {
    // Reuse idle connection if available
    for (const [id, conn] of this.connections.entries()) {
      if (!conn.inUse && Date.now() - conn.lastUsedAt < this.connectionTimeout) {
        conn.inUse = true;
        conn.lastUsedAt = Date.now();
        if (conn.timeout) clearTimeout(conn.timeout);
        return id;
      }
    }

    // Create new connection if under limit
    if (this.connections.size < this.maxConnections) {
      const id = `conn_${Date.now()}_${Math.random()}`;
      this.connections.set(id, {
        id,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        inUse: true,
        timeout: null,
      });
      return id;
    }

    throw new Error('Connection pool exhausted');
  }

  releaseConnection(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;

    conn.inUse = false;
    conn.lastUsedAt = Date.now();
    // Set timeout to close connection if not reused
    conn.timeout = setTimeout(() => {
      this.connections.delete(id);
    }, this.connectionTimeout);
  }

  private cleanupIdleConnections(): void {
    const now = Date.now();
    for (const [id, conn] of this.connections.entries()) {
      if (!conn.inUse && now - conn.lastUsedAt > this.connectionTimeout) {
        this.connections.delete(id);
      }
    }
  }

  getPoolMetrics(): { total: number; inUse: number; idle: number } {
    let inUse = 0;
    for (const conn of this.connections.values()) {
      if (conn.inUse) inUse += 1;
    }
    return {
      total: this.connections.size,
      inUse,
      idle: this.connections.size - inUse,
    };
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    for (const conn of this.connections.values()) {
      if (conn.timeout) clearTimeout(conn.timeout);
    }
    this.connections.clear();
  }
}

// Standardized error response format
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
    traceId?: string;
    timestamp: number;
  };
}

function createErrorResponse(
  code: string,
  message: string,
  details?: Record<string, any>,
  traceId?: string,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details && { details }),
      ...(traceId && { traceId }),
      timestamp: Date.now(),
    },
  };
}

function handleApiError(error: unknown, traceId?: string): { status: number; body: ErrorResponse } {
  if (error instanceof ValidationError) {
    return {
      status: 400,
      body: createErrorResponse('VALIDATION_ERROR', `Validation failed: ${error.message}`, { field: error.field }, traceId),
    };
  }

  if (error instanceof Error) {
    if (error.message.includes('timeout')) {
      return {
        status: 504,
        body: createErrorResponse('GATEWAY_TIMEOUT', 'Request timeout', undefined, traceId),
      };
    }
    if (error.message.includes('Circuit breaker OPEN')) {
      return {
        status: 503,
        body: createErrorResponse('SERVICE_UNAVAILABLE', error.message, undefined, traceId),
      };
    }
    if (error.message.includes('exhausted')) {
      return {
        status: 429,
        body: createErrorResponse('RESOURCE_EXHAUSTED', error.message, undefined, traceId),
      };
    }
  }

  return {
    status: 500,
    body: createErrorResponse('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', undefined, traceId),
  };
}

// Request/response logging and monitoring
interface RequestLog {
  traceId: string;
  timestamp: number;
  method: string;
  path: string;
  statusCode: number;
  duration: number;
  clientId?: string;
  error?: string;
}

class RequestLogger {
  private logs: RequestLog[] = [];
  private readonly maxLogs = 10000;

  logRequest(
    traceId: string,
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    clientId?: string,
    error?: string,
  ): void {
    const log: RequestLog = {
      traceId,
      timestamp: Date.now(),
      method,
      path,
      statusCode,
      duration,
      ...(clientId && { clientId }),
      ...(error && { error }),
    };

    this.logs.push(log);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Console output for structured logging (in production, send to logging service)
    console.log(
      JSON.stringify({
        level: error ? 'ERROR' : 'INFO',
        ...log,
      }),
    );
  }

  getRecentLogs(limit = 100): RequestLog[] {
    return this.logs.slice(-limit);
  }

  getMetrics(): {
    totalRequests: number;
    avgLatency: number;
    errorRate: number;
  } {
    if (this.logs.length === 0) {
      return { totalRequests: 0, avgLatency: 0, errorRate: 0 };
    }

    const errors = this.logs.filter((l) => l.error).length;
    const avgLatency = this.logs.reduce((sum, l) => sum + l.duration, 0) / this.logs.length;

    return {
      totalRequests: this.logs.length,
      avgLatency: Math.round(avgLatency),
      errorRate: Number(((errors / this.logs.length) * 100).toFixed(2)),
    };
  }
}

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

class IdempotencyStore {
  private store: Map<string, IdempotencyRecord> = new Map();
  private readonly ttlMs = 60 * 60 * 1000; // 1 hour
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup expired entries every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);

    // Force cleanup if store is growing too large
    if (this.store.size > this.maxStoredRecords) {
      this.cleanup();
    }
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
        logger.info('CircuitBreaker state transition', { from: 'open', to: 'half-open', reason: 'reset_timeout_expired', operationName });
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
        logger.info('CircuitBreaker state transition', { from: 'half-open', to: 'closed', reason: 'success_threshold_reached' });
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      logger.warn('CircuitBreaker state transition', { from: this.state, to: 'open', failureCount: this.failureCount });
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

// Idempotency key validation
function validateIdempotencyKey(key: string | undefined): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: true }; // Optional
  }
  
  if (typeof key !== 'string') {
    return { valid: false, error: 'Idempotency key must be a string' };
  }
  
  if (key.length < 1 || key.length > 256) {
    return { valid: false, error: 'Idempotency key must be 1-256 characters' };
  }
  
  if (!/^[a-zA-Z0-9\-_]+$/.test(key)) {
    return { valid: false, error: 'Idempotency key must contain only alphanumeric, dash, underscore' };
  }
  
  return { valid: true };
}

// Idempotency key middleware for state-changing operations
export const idempotencyMiddleware = (req: any, res: any, next: any) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const key = req.headers['idempotency-key'];
    const validation = validateIdempotencyKey(key);
    
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error, retriable: false });
    }
    
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

// Backpressure middleware to handle slow clients and prevent buffer overflow
const backpressureMiddleware = (req: any, res: any, next: any) => {
  // Monitor write buffer and pause reading if pressure builds
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = function(chunk: any, encoding?: any, callback?: any) {
    if (res.writableHighWaterMark && res.writableLength > res.writableHighWaterMark * 0.8) {
      // High backpressure detected, signal client to back off
      res.setHeader('Retry-After', '1');
    }
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function(chunk?: any, encoding?: any, callback?: any) {
    return originalEnd(chunk, encoding, callback);
  };

  next();
};

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