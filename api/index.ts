// ============================================
// Pagination and Streaming Response Handler
// ============================================
interface PaginationOptions {
  limit: number;
  cursor?: string;
}

interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string;
  hasMore: boolean;
}

// Cursor encoding/decoding for pagination state
class CursorPaginator {
  private readonly chunkSize: number = 50; // items per page
  
  encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ offset })).toString('base64');
  }
  
  decodeCursor(cursor: string): number {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
      return decoded.offset || 0;
    } catch {
      return 0;
    }
  }
  
  paginate<T>(items: T[], cursor?: string, limit: number = this.chunkSize): PaginatedResponse<T> {
    const offset = cursor ? this.decodeCursor(cursor) : 0;
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    
    return {
      data: page,
      nextCursor: nextOffset < items.length ? this.encodeCursor(nextOffset) : undefined,
      hasMore: nextOffset < items.length
    };
  }
}

// Streaming response helper for chunked delivery
class StreamingResponseHandler {
  private readonly chunkSizeBytes: number = 8192; // 8KB chunks
  
  streamJSON(res: any, data: any[]): Promise<void> {
    return new Promise((resolve) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write('[');
      
      let index = 0;
      const sendChunk = () => {
        if (index >= data.length) {
          res.write(']');
          res.end();
          resolve();
          return;
        }
        
        const chunk = data[index];
        const json = JSON.stringify(chunk);
        if (index > 0) res.write(',');
        res.write(json);
        index++;
        
        // Throttle chunk delivery to avoid overwhelming clients
        setImmediate(sendChunk);
      };
      
      sendImmediate(sendChunk);
    });
  }
}

function setImmediate(cb: () => void) {
  setTimeout(cb, 0);
}

// ============================================
// Database Query Batching and N+1 Prevention
// ============================================

// DataLoader pattern: batch multiple individual queries into single batch operation
class DataLoader<K, V> {
  private queue: Array<{ key: K; resolve: (v: V) => void; reject: (e: Error) => void }> = [];
  private batchScheduled = false;
  private readonly batchFn: (keys: K[]) => Promise<Map<K, V>>;
  private readonly batchSize: number;
  
  constructor(batchFn: (keys: K[]) => Promise<Map<K, V>>, batchSize: number = 100) {
    this.batchFn = batchFn;
    this.batchSize = batchSize;
  }
  
  load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      
      // Schedule batch on next tick if not already scheduled
      if (!this.batchScheduled) {
        this.batchScheduled = true;
        setImmediate(() => this.processBatch());
      }
      
      // Also process immediately if we hit batch size limit
      if (this.queue.length >= this.batchSize) {
        this.processBatch();
      }
    });
  }
  
  private async processBatch(): Promise<void> {
    if (this.queue.length === 0) {
      this.batchScheduled = false;
      return;
    }
    
    const batch = this.queue.splice(0, this.batchSize);
    const keys = batch.map(item => item.key);
    
    try {
      const results = await this.batchFn(keys);
      
      for (const item of batch) {
        const value = results.get(item.key);
        if (value !== undefined) {
          item.resolve(value);
        } else {
          item.reject(new Error(`No value found for key: ${item.key}`));
        }
      }
    } catch (err) {
      for (const item of batch) {
        item.reject(err as Error);
      }
    }
    
    // Continue processing remaining queue
    if (this.queue.length > 0) {
      setImmediate(() => this.processBatch());
    } else {
      this.batchScheduled = false;
    }
  }
  
  clear(): void {
    this.queue = [];
    this.batchScheduled = false;
  }
}

// Query batching helper for consolidating multiple DB queries
class QueryBatcher {
  private batches: Map<string, { keys: Set<any>; promise: Promise<Map<any, any>> | null }> = new Map();
  
  // Batch multiple IDs into single query instead of N individual queries
  async batchFetch<T>(
    queryId: string,
    ids: any[],
    batchQueryFn: (ids: any[]) => Promise<Map<any, T>>
  ): Promise<Map<any, T>> {
    // If batch already exists and has pending promise, wait for it
    if (!this.batches.has(queryId)) {
      this.batches.set(queryId, { keys: new Set(), promise: null });
    }
    
    const batch = this.batches.get(queryId)!;
    
    // Add new IDs to batch
    for (const id of ids) {
      batch.keys.add(id);
    }
    
    // Execute batch on next tick if not already scheduled
    if (!batch.promise) {
      batch.promise = new Promise((resolve) => {
        setImmediate(async () => {
          const keysArray = Array.from(batch.keys);
          batch.keys.clear();
          
          try {
            const result = await batchQueryFn(keysArray);
            resolve(result);
          } catch (err) {
            console.error(`Batch query failed for ${queryId}:`, err);
            resolve(new Map());
          } finally {
            batch.promise = null;
          }
        });
      });
    }
    
    return batch.promise;
  }
  
  // Eager load relationships to prevent N+1 queries
  async eagerLoad<T, R>(
    items: T[],
    relationshipIds: (item: T) => any[],
    batchLoader: (ids: any[]) => Promise<Map<any, R>>
  ): Promise<Map<any, R>> {
    const allIds = new Set<any>();
    for (const item of items) {
      const ids = relationshipIds(item);
      for (const id of ids) {
        allIds.add(id);
      }
    }
    
    if (allIds.size === 0) {
      return new Map();
    }
    
    // Single batch query instead of N individual queries
    return batchLoader(Array.from(allIds));
  }
  
  clear(): void {
    this.batches.clear();
  }
}

// ============================================
// Express Integration and Example Handlers
// ============================================

// Initialize performance utilities
const cacheManager = new CacheManager(60000); // 60 second cleanup
const paginator = new CursorPaginator();
const streamHandler = new StreamingResponseHandler();
const queryBatcher = new QueryBatcher();

// Example: Paginated endpoint with caching and query batching
function createPaginatedHandler(dataFetcher: () => Promise<any[]>) {
  return async (req: any, res: any) => {
    const { cursor, limit = 50 } = req.query;
    const cacheKey = cacheManager.generateQueryKey('/api/items', { cursor, limit });
    
    try {
      // Use deduplication to prevent parallel identical requests
      const result = await cacheManager.getOrFetch(
        cacheKey,
        async () => {
          // Fetch data with query batching enabled
          const data = await dataFetcher();
          return paginator.paginate(data, cursor, parseInt(limit));
        },
        5 * 60 * 1000 // 5 minute TTL
      );
      
      res.set('X-Cache', 'HIT');
      res.json(result);
    } catch (err) {
      console.error('Handler error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Example: Streaming large dataset endpoint
function createStreamingHandler(dataFetcher: () => Promise<any[]>) {
  return async (req: any, res: any) => {
    try {
      const data = await dataFetcher();
      await streamHandler.streamJSON(res, data);
    } catch (err) {
      console.error('Streaming error:', err);
      res.status(500).json({ error: 'Streaming failed' });
    }
  };
}

// Export utilities for use in other modules
export { CacheManager, CursorPaginator, StreamingResponseHandler, QueryBatcher, DataLoader, createCacheMiddleware, createPaginatedHandler, createStreamingHandler };
export { cacheManager, paginator, streamHandler, queryBatcher };

// ============================================
// Database Connection Pool Configuration
// ============================================
// ============================================
// Request Cache Manager (Response Caching)
// ============================================
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // milliseconds
}

export class CacheManager {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private pendingRequests: Map<string, Promise<any>> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor(cleanupIntervalMs: number = 60000) {
    // Auto-cleanup expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }
  
  // Generate deterministic cache key from query parameters
  generateQueryKey(endpoint: string, params: Record<string, any>): string {
    const sorted = Object.keys(params).sort().map(k => `${k}=${JSON.stringify(params[k])}`).join('&');
    return `query:${endpoint}:${sorted}`;
  }
  
  // Deduplication: prevent parallel identical requests from hitting DB
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs: number = 60000): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) return cached as T;
    
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key)!;
    }
    
    const promise = fetcher().then(result => {
      this.set(key, result, ttlMs);
      this.pendingRequests.delete(key);
      return result;
    }).catch(err => {
      this.pendingRequests.delete(key);
      throw err;
    });
    
    this.pendingRequests.set(key, promise);
    return promise;
  }
  
  set<T>(key: string, data: T, ttlMs: number = 60000): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
  }
  
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    
    const isExpired = Date.now() - entry.timestamp > entry.ttl;
    if (isExpired) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }
  
  invalidate(pattern: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }
  
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }
  
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }
}

// Global cache instance
export const apiCache = new CacheManager();

// ============================================
// Cache Middleware Factory
// ============================================
export function cacheMiddleware(ttlMs: number = 60000) {
  return (req: any, res: any, next: any) => {
    const originalJson = res.json.bind(res);
    
    res.json = function(data: any) {
      // Generate cache key from method, path, and query
      const cacheKey = `${req.method}:${req.path}:${JSON.stringify(req.query)}`;
      
      // Cache successful responses (status 200-299)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        apiCache.set(cacheKey, data, ttlMs);
      }
      
      return originalJson(data);
    };
    
    // Check cache before calling next middleware
    const cacheKey = `${req.method}:${req.path}:${JSON.stringify(req.query)}`;
    const cachedResponse = apiCache.get(cacheKey);
    
    if (cachedResponse !== null) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedResponse);
    }
    
    res.set('X-Cache', 'MISS');
    next();
  };
}

// ============================================
// Database Connection Pool Configuration
// ============================================
export const connectionPoolConfig = {
  min: 2,           // Minimum connections in pool
  max: 10,          // Maximum connections in pool
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Connection timeout
  statement_timeout: 30000,  // Query timeout
  max_pool_size: 10,
  reapInterval: 1000,  // Check for idle connections every 1s
};

// ============================================
// Cursor-Based Pagination Utilities
// ============================================
export interface PaginationParams {
  cursor?: string; // Base64-encoded cursor
  limit?: number;  // Default 20, max 100
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null; // Null when no more items
  hasMore: boolean;
  count: number;
}

// Encode cursor (id + offset)
export function encodeCursor(id: string | number, offset: number = 0): string {
  return Buffer.from(`${id}:${offset}`).toString('base64');
}

// Decode cursor
export function decodeCursor(cursor: string): { id: string; offset: number } {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [id, offset] = decoded.split(':');
    return { id, offset: parseInt(offset, 10) || 0 };
  } catch {
    return { id: '', offset: 0 };
  }
}

// Build paginated response with cursor
export function buildPaginatedResponse<T>(
  items: T[],
  cursor: string | undefined,
  limit: number = 20,
  totalCount: number
): PaginatedResponse<T> {
  const { offset } = cursor ? decodeCursor(cursor) : { offset: 0 };
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < totalCount;
  
  return {
    data: items,
    nextCursor: hasMore ? encodeCursor(items[items.length - 1] as any, nextOffset) : null,
    hasMore,
    count: items.length,
  };
}

// Streaming pagination helper - streams items without loading entire dataset
export async function* streamPaginatedResults<T>(
  queryFn: (offset: number, limit: number) => Promise<T[]>,
  limit: number = 20,
  totalItems: number
): AsyncGenerator<T[], void, unknown> {
  let offset = 0;
  while (offset < totalItems) {
    const batch = await queryFn(offset, limit);
    if (batch.length === 0) break;
    yield batch;
    offset += batch.length;
  }
}

// ============================================
// Batch Loading Utility (N+1 Query Prevention)
// ============================================
class BatchLoader<T, K> {
  private queue: T[] = [];
  private pendingPromise: Promise<Map<K, any>> | null = null;
  private resolveQueue: Function | null = null;
  private timeoutId: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushInterval: number; // ms
  private readonly batchFn: (items: T[]) => Promise<Map<K, any>>;

  constructor(batchFn: (items: T[]) => Promise<Map<K, any>>, batchSize: number = 100, flushInterval: number = 10) {
    this.batchFn = batchFn;
    this.batchSize = batchSize;
    this.flushInterval = flushInterval;
  }

  load(item: T): Promise<any> {
    this.queue.push(item);
    
    if (!this.pendingPromise) {
      this.pendingPromise = new Promise((resolve) => {
        this.resolveQueue = resolve;
        
        // Schedule flush
        if (this.queue.length >= this.batchSize) {
          this.flushBatch();
        } else if (!this.timeoutId) {
          this.timeoutId = setTimeout(() => this.flushBatch(), this.flushInterval);
        }
      });
    }
    
    return this.pendingPromise.then((results) => results.get(item as unknown as K));
  }
  
  private async flushBatch(): Promise<void> {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    const itemsToProcess = this.queue.splice(0, this.batchSize);
    if (itemsToProcess.length === 0) return;
    
    try {
      const results = await this.batchFn(itemsToProcess);
      if (this.resolveQueue) {
        this.resolveQueue(results);
        this.resolveQueue = null;
        this.pendingPromise = null;
      }
    } catch (error) {
      console.error('BatchLoader flush error:', error);
      if (this.resolveQueue) {
        this.resolveQueue(new Map());
        this.resolveQueue = null;
        this.pendingPromise = null;
      }
    }
  }
    
    if (!this.pendingPromise) {
      this.pendingPromise = new Promise((resolve) => {
        this.resolveQueue = resolve;
        
        // Flush on batch size or timeout
        if (this.queue.length >= this.batchSize) {
          this.flush();
        } else {
          if (this.timeoutId) clearTimeout(this.timeoutId);
          this.timeoutId = setTimeout(() => this.flush(), this.flushInterval);
        }
      });
    }
    
    return this.pendingPromise.then(() => this.pendingPromise!);
  }

  private async flush() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    if (this.queue.length === 0) return;
    
    const batch = this.queue;
    this.queue = [];
    
    try {
      const result = await this.batchFn(batch);
      if (this.resolveQueue) {
        this.resolveQueue(result);
      }
    } catch (err) {
      console.error('BatchLoader flush error:', err);
    }
    
    this.pendingPromise = null;
    this.resolveQueue = null;
  }
}

// ============================================
// Pagination and Lazy Loading Utilities
// ============================================
interface PaginationOptions {
  cursor?: string;
  limit?: number;
  expand?: string[];
}

class PaginationHelper {
  static encodeCursor(id: string, timestamp: number; ttl: number): string {
    return Buffer.from(`${id}:${timestamp}`).toString('base64');
  }

  static decodeCursor(cursor: string): { id: string; timestamp: number } | null {
    try {
      const [id, timestamp] = Buffer.from(cursor, 'base64').toString().split(':');
      return { id, timestamp: parseInt(timestamp, 10) };
    } catch {
      return null;
    }
  }

  static paginate(items: any[], options: PaginationOptions, keyField: string = 'id') {
    const limit = Math.min(options.limit || 20, 100);
    let startIdx = 0;

    if (options.cursor) {
      const decoded = this.decodeCursor(options.cursor);
      if (decoded) {
        startIdx = items.findIndex(item => item[keyField] === decoded.id);
        if (startIdx >= 0) startIdx += 1;
      }
    }

    const pageItems = items.slice(startIdx, startIdx + limit);
    const nextCursor = pageItems.length === limit && startIdx + limit < items.length
      ? this.encodeCursor(pageItems[pageItems.length - 1][keyField], Date.now())
      : null;

    return { items: pageItems, nextCursor, hasMore: !!nextCursor };
  }

  static lazyLoadNested(items: any[], expand?: string[]): any[] {
    if (!expand || expand.length === 0) {
      return items.map(item => {
        const { nested, ...rest } = item;
        return rest;
      });
    }
    return items;
  }

  // Apply batch loading to expand nested relations without N+1 queries
  static async expandWithBatchLoading(
    items: any[],
    expandFields: string[],
    loaderMap: Map<string, BatchLoader<any, any>>
  ) {
    for (const field of expandFields) {
      const loader = loaderMap.get(field);
      if (!loader) continue;
      
      for (const item of items) {
        if (item[`${field}_id`]) {
          item[field] = await loader.load(item[`${field}_id`]);
        }
      }
    }
    return items;
  }
}

import app from '../src/index.js';
import { createCacheMiddleware, correlationIdMiddleware, createETagMiddleware } from './index.js';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import compression from 'compression';

// ============================================
// Response Caching Middleware
// ============================================
interface CacheEntry {
  data: any;
  etag: string;
  timestamp: number;
  ttl: number;
}

class ResponseCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
    this.cleanupInterval = setInterval(() => this.prune(), 60000);
  }

  set(key: string, data: any, ttl: number = 300000): string {
    const content = JSON.stringify(data);
    const etag = `"${crypto.createHash('md5').update(content).digest('hex')}"` ;

    if (this.cache.size >= this.maxSize) {
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }

    this.cache.set(key, { data, etag, timestamp: Date.now(), ttl });
    return etag;
  }

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }
}

const responseCache = new ResponseCache(100);

export function createCacheMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalSend = res.send;

    res.send = function(data: any) {
      if (req.method === 'GET' && res.statusCode === 200) {
        const cacheKey = `${req.method}:${req.path}:${JSON.stringify(req.query)}`;
        const etag = responseCache.set(cacheKey, data, 300000);

        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        res.setHeader('Vary', 'Accept-Encoding');

        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          return res.end();
        }
      }
      return originalSend.call(this, data);
    };

    next();
  };
}

// ============================================
// Connection Pool Management
// ============================================
interface ConnectionPoolConfig {
  minConnections?: number;
  maxConnections?: number;
  idleTimeout?: number;
  connectionTimeout?: number;
}

class QueryBatcher {
  private queries: Array<{ sql: string; params: any; resolve: (result: any) => void; reject: (error: any) => void }> = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private batchSize: number = 10;
  private flushInterval: number = 50;

  add(sql: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queries.push({ sql, params, resolve, reject });
      if (this.queries.length >= this.batchSize) {
        this.flush();
      } else if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => this.flush(), this.flushInterval);
      }
    });
  }

  private flush(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    if (this.queries.length === 0) return;

    const batch = this.queries.splice(0, this.batchSize);
    try {
      batch.forEach(q => q.resolve({ batched: true, originalSql: q.sql }));
    } catch (error) {
      batch.forEach(q => q.reject(error));
    }
  }
}

class ConnectionPool {
  private availableConnections: any[] = [];
  private activeConnections: Set<any> = new Set();
  private waitingQueue: Array<(conn: any) => void> = [];
  private config: Required<ConnectionPoolConfig>;
  private queryBatcher: QueryBatcher = new QueryBatcher();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: ConnectionPoolConfig = {}) {
    this.config = {
      minConnections: config.minConnections || 5,
      maxConnections: config.maxConnections || 20,
      idleTimeout: config.idleTimeout || 30000,
      connectionTimeout: config.connectionTimeout || 10000
    };
    this.initializePool();
  }

  private initializePool() {
    for (let i = 0; i < this.config.minConnections; i++) {
      this.availableConnections.push({ id: i, createdAt: Date.now() });
    }
    this.startCleanupInterval();
  }

  private startCleanupInterval() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      this.availableConnections = this.availableConnections.filter(conn => {
        return now - conn.createdAt < this.config.idleTimeout;
      });
    }, this.config.idleTimeout);
  }

  async acquire(): Promise<any> {
    if (this.availableConnections.length > 0) {
      return this.availableConnections.pop()!;
    }

    if (this.activeConnections.size < this.config.maxConnections) {
      const conn = { id: Math.random(), createdAt: Date.now() };
      this.activeConnections.add(conn);
      return conn;
    }

    return new Promise(resolve => {
      this.waitingQueue.push(resolve);
      setTimeout(() => {
        const idx = this.waitingQueue.indexOf(resolve);
        if (idx > -1) this.waitingQueue.splice(idx, 1);
      }, this.config.connectionTimeout);
    });
  }

  release(conn: any) {
    this.activeConnections.delete(conn);
    if (this.waitingQueue.length > 0) {
      const resolve = this.waitingQueue.shift()!;
      resolve(conn);
    } else {
      this.availableConnections.push(conn);
    }
  }

  destroy() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.availableConnections = [];
    this.activeConnections.clear();
    this.waitingQueue = [];
  }
}

export const dbConnectionPool = new ConnectionPool({ maxConnections: 20 });

// ============================================
// Async Database Access Wrapper
// ============================================
export async function withDatabaseConnection<T>(
  operation: (conn: any) => Promise<T>
): Promise<T> {
  const conn = await dbConnectionPool.acquire();
  try {
    return await operation(conn);
  } finally {
    dbConnectionPool.release(conn);
  }
}

// ============================================
// Reliability Utilities Re-export
// ============================================
// Re-export utilities from src for use in route handlers
export {
  wrapAsyncHandler,
  retryWithExponentialBackoff,
  getOrCreateCircuitBreaker,
  Mutex,
  stateMutex,
  createErrorResponse,
  StandardizedError,
  RetryOptions,
  CircuitBreakerState,
  BatchQuery,
  PaginationHelper,
  PaginationCursor,
  ConnectionPool,
  AsyncDatabaseClient,
  CacheManager,
  createCacheMiddleware
} from '../src/index.js';

// Extend Express Request type with timeout and correlation fields
declare global {
  namespace Express {
    interface Request {
      timeout?: number;
      correlationId?: string;
      pagination?: { limit: number; offset: number };
    }
  }
}

// ============================================
// Compression and Request Validation Middleware
// ============================================
const compressionMiddleware = compression({
  level: 6,
  threshold: 1024,
  filter: (req: Request, res: Response) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
});

const requestValidator = (req: Request, res: Response, next: Function) => {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const maxRequestSize = 5 * 1024 * 1024;

  if (contentLength > maxRequestSize) {
    return res.status(413).json({ error: 'Payload too large', maxSize: maxRequestSize });
  }
  next();
};

// ============================================
// Async Error Handler Wrapper & Rejection Tracking
// ============================================
const rejectionTracker = new Map<string, { count: number; lastError: string; timestamp: number }>();

export function wrapAsyncHandler(handler: (req: Request, res: Response, next?: any) => Promise<any>) {
  return async (req: Request, res: Response, next: any) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      const correlationId = (req as any).correlationId || 'unknown';
      console.error(`[${correlationId}] Async handler error caught:`, error);

      const errorEntry = rejectionTracker.get(correlationId) || { count: 0, lastError: '', timestamp: Date.now() };
      errorEntry.count++;
      errorEntry.lastError = error instanceof Error ? error.message : String(error);
      errorEntry.timestamp = Date.now();
      rejectionTracker.set(correlationId, errorEntry);

      if (!res.headersSent) {
        res.status(500).json({
          status: 500,
          message: 'Internal Server Error',
          correlationId,
          timestamp: new Date().toISOString(),
          code: 'ASYNC_HANDLER_ERROR'
        });
      }
      next(error);
    }
  };
}

export function getRejectionMetrics(): Array<{id: string; count: number; lastError: string; timestamp: number}> {
  return Array.from(rejectionTracker.entries()).map(([id, metrics]) => ({
    id,
    count: metrics.count,
    lastError: metrics.lastError,
    timestamp: metrics.timestamp
  }));
}

// Global unhandled rejection tracking
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  const errorMsg = reason instanceof Error ? reason.message : String(reason);
  console.error('[GLOBAL] Unhandled Rejection:', errorMsg, promise);
  const entry = rejectionTracker.get('global_unhandled') || { count: 0, lastError: '', timestamp: Date.now() };
  entry.count++;
  entry.lastError = errorMsg;
  entry.timestamp = Date.now();
  rejectionTracker.set('global_unhandled', entry);
});
// Apply optimizations to Express app
app.use(compressionMiddleware);
app.use(requestValidator);
app.use(correlationIdMiddleware);
app.use(timeoutMiddleware(DEFAULT_REQUEST_TIMEOUT));
app.use(createCacheMiddleware({ defaultTtl: 30000 }));
app.use(createETagMiddleware());
app.use(paginationMiddleware);

// ============================================
// Health and Readiness Probes
// ============================================
let isReady = false;
let healthStatus = {
  uptime: process.uptime(),
  memoryUsage: process.memoryUsage(),
  circuitBreakers: {} as Record<string, string>,
  lastCheck: new Date().toISOString()
};

app.get('/health', (req: Request, res: Response) => {
  healthStatus = {
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    circuitBreakers: {},
    lastCheck: new Date().toISOString()
  };
  res.status(200).json({ status: 'healthy', details: healthStatus });
});

app.get('/ready', (req: Request, res: Response) => {
  if (isReady && !isShuttingDown) {
    res.status(200).json({ status: 'ready' });
  } else {
    res.status(503).json({ status: 'not_ready' });
  }
});

// Signal readiness after initialization
setTimeout(() => {
  isReady = true;
  console.log('[HEALTH] Service marked as ready');
}, 1000);

process.on('SIGTERM', () => {
  isReady = false;
  console.log('[HEALTH] Service marked as not ready for shutdown');
});

// Re-export Express app for integration
export default app;

// ============================================
// Batch Query Utility: Prevent N+1 Database Patterns
// ============================================
export interface PaginationParams {
  offset: number;
  limit: number;
}

export function getPaginationParams(query: any, maxLimit: number = 100, defaultLimit: number = 20): PaginationParams {
  const offset = Math.max(0, parseInt(query.offset || '0', 10));
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit || defaultLimit.toString(), 10)));
  return { offset, limit };
}

/**
 * Batch load related resources to prevent N+1 queries.
 * Instead of looping through results and making individual queries,
 * collect all IDs and fetch in a single batch query.
 * Usage: const roasters = await batchLoadRelated(roasterIds, 'roasters', db.fetchRoastersByIds)
 */
export async function batchLoadRelated<T>(
  ids: (string | number)[],
  resourceName: string,
  fetchFn: (ids: (string | number)[]) => Promise<Map<string | number, T>>
): Promise<Map<string | number, T>> {
  if (ids.length === 0) return new Map();
  const uniqueIds = [...new Set(ids)];
  return fetchFn(uniqueIds);
}

/**
 * ETag middleware: Compute ETags and handle If-None-Match requests.
 * Returns 304 Not Modified for unchanged resources, reducing bandwidth.
 */
export { ResponseCache, responseCache };
export { QueryBatcher };
export { PaginationHelper };

export function createETagMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json;
    res.json = function(body: any) {
      const etagValue = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex');
      res.set('ETag', `"${etagValue}"`);
      res.set('Cache-Control', 'public, max-age=300');

      const clientETag = req.get('If-None-Match');
      if (clientETag === `"${etagValue}"`) {
        return res.status(304).end();
      }
      return originalJson.call(this, body);
    };
    next();
  };
}

export function paginationMiddleware(req: Request, res: Response, next: NextFunction) {
  const pagination = getPaginationParams(req.query);
  (req as any).pagination = pagination;
  next();
}

// ============================================
// Cache Manager with Redis Support & Event-Driven Invalidation
// ============================================
class CacheManager extends EventEmitter {
  private memoryCache: Map<string, { data: any; ttl: number; timestamp: number }> = new Map();
  private ttlMap: Map<string, NodeJS.Timeout> = new Map();
  private redisClient: any = null;
  private isRedisAvailable: boolean = false;

  constructor(redisClient?: any) {
    super();
    this.redisClient = redisClient;
    this.isRedisAvailable = !!redisClient;
  }

  async get(key: string): Promise<any | null> {
    const memEntry = this.memoryCache.get(key);
    if (memEntry && Date.now() - memEntry.timestamp < memEntry.ttl) {
      return memEntry.data;
    }
    if (memEntry) this.memoryCache.delete(key);
    if (this.isRedisAvailable && this.redisClient) {
      try {
        const redisData = await this.redisClient.get(key);
        if (redisData) {
          const parsed = JSON.parse(redisData);
          this.memoryCache.set(key, { data: parsed, ttl: 300000, timestamp: Date.now() });
          return parsed;
        }
      } catch (err) {
        console.error(`[CacheManager] Redis get error for key ${key}:`, err);
      }
    }
    return null;
  }

  async set(key: string, data: any, ttl: number = 300000): Promise<void> {
    this.memoryCache.set(key, { data, ttl, timestamp: Date.now() });
    if (this.ttlMap.has(key)) clearTimeout(this.ttlMap.get(key)!);
    this.ttlMap.set(key, setTimeout(() => {
      this.memoryCache.delete(key);
      this.ttlMap.delete(key);
      this.emit('cache:expired', key);
    }, ttl));
    if (this.isRedisAvailable && this.redisClient) {
      try {
        await this.redisClient.setex(key, Math.ceil(ttl / 1000), JSON.stringify(data));
      } catch (err) {
        console.error(`[CacheManager] Redis set error for key ${key}:`, err);
      }
    }
  }

  async invalidate(pattern?: RegExp | string): Promise<void> {
    if (!pattern) {
      this.memoryCache.clear();
      this.ttlMap.forEach(timer => clearTimeout(timer));
      this.ttlMap.clear();
    } else {
      const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
      for (const key of this.memoryCache.keys()) {
        if (regex.test(key)) {
          this.memoryCache.delete(key);
          const timer = this.ttlMap.get(key);
          if (timer) clearTimeout(timer);
          this.ttlMap.delete(key);
        }
      }
    }
    this.emit('cache:invalidated', pattern);
  }
}

export const cacheManager = new CacheManager();

// ============================================
// Query Result Caching & Memoization
// ============================================
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class QueryCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private ttl: number;

  constructor(ttl: number = 300000) {
    this.ttl = ttl;
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttl?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.ttl
    });
  }

  invalidate(keyPattern?: RegExp): void {
    if (!keyPattern) {
      this.cache.clear();
    } else {
      for (const key of this.cache.keys()) {
        if (keyPattern.test(key)) {
          this.cache.delete(key);
        }
      }
    }
  }

  size(): number {
    return this.cache.size;
  }
}

export function createQueryCache<T>(
  queryFn: (params: any) => Promise<T>,
  keyGenerator: (params: any) => string,
  ttl: number = 300000
): (params: any) => Promise<T> {
  const cache = new QueryCache<T>(ttl);
  return async (params: any) => {
    const key = keyGenerator(params);
    const cached = cache.get(key);
    if (cached !== null) return cached;
    const result = await queryFn(params);
    cache.set(key, result, ttl);
    return result;
  };
}

// ============================================
// Database Query Optimization - Batch Queries & Pagination
// ============================================
interface BatchQueryOptions {
  batchSize?: number;
  timeout?: number;
}

interface PaginationCursor {
  token: string;
  hasMore: boolean;
  nextCursor?: string;
}

class BatchQuery {
  private queue: Map<string, any[]> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private batchSize: number;
  private timeout: number;

  constructor(options: BatchQueryOptions = {}) {
    this.batchSize = options.batchSize || 100;
    this.timeout = options.timeout || 50;
  }

  async add<T>(key: string, item: T, executor: (items: T[]) => Promise<any>): Promise<any> {
    if (!this.queue.has(key)) {
      this.queue.set(key, []);
    }
    const batch = this.queue.get(key)!;
    batch.push(item);

    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
    }

    if (batch.length >= this.batchSize) {
      return this.flush(key, executor);
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => this.flush(key, executor).then(resolve), this.timeout);
      this.timers.set(key, timer);
    });
  }

  private async flush<T>(key: string, executor: (items: T[]) => Promise<any>): Promise<any> {
    const batch = this.queue.get(key);
    if (!batch || batch.length === 0) return null;
    this.queue.delete(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    return executor(batch);
  }
}

export class PaginationCursorUtil {
  static encode(offset: number, limit: number): string {
    return Buffer.from(JSON.stringify({ offset, limit })).toString('base64');
  }

  static decode(cursor: string): { offset: number; limit: number } {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  }

  static createResponse<T>(items: T[], offset: number, limit: number, total: number): PaginationCursor & { items: T[] } {
    const hasMore = offset + limit < total;
    const nextCursor = hasMore ? this.encode(offset + limit, limit) : undefined;
    return {
      items,
      token: this.encode(offset, limit),
      hasMore,
      nextCursor
    };
  }
}

export const batchQuery = new BatchQuery({ batchSize: 100, timeout: 50 });

// ============================================
// N+1 Query Optimization: Batch Loading & Eager Loading
// ============================================
export function createBatchLoader<T, K>(
  resolver: (keys: K[]) => Promise<(T | Error)[]>,
  cacheKeyFn?: (key: K) => string
) {
  const cache = new Map<string, Promise<T | Error>>();
  let batch: K[] = [];
  let batchPromise: Promise<(T | Error)[]> | null = null;
  let resultsByKey = new Map<string, T | Error>();

  function load(key: K): Promise<T | Error> {
    const cacheKey = cacheKeyFn ? cacheKeyFn(key) : String(key);

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)!;
    }

    batch.push(key);

    if (!batchPromise) {
      batchPromise = new Promise<(T | Error)[]>(resolve => {
        setImmediate(async () => {
          const keys = batch;
          batch = [];
          resultsByKey.clear();
          const results = await resolver(keys);
          keys.forEach((key, idx) => {
            const resultKey = cacheKeyFn ? cacheKeyFn(key) : String(key);
            resultsByKey.set(resultKey, results[idx]);
          });
          resolve(results);
          batchPromise = null;
        });
      });
    }

    const resultPromise = batchPromise.then(() => {
      const cacheKey = cacheKeyFn ? cacheKeyFn(key) : String(key);
      return resultsByKey.get(cacheKey)!;
    });
    cache.set(cacheKey, resultPromise);
    return resultPromise;
  }

  function clearCache(): void {
    cache.clear();
    resultsByKey.clear();
  }

  return { load, clearCache };
}

export function createEagerLoader<T>(
  getIdFn: (item: T) => string | number,
  joinFn: (items: T[], relatedIds: (string | number)[]) => Promise<T[]>
) {
  const relationshipCache = new Map<string, T[]>();

  return async function eagerLoad(items: T[]): Promise<T[]> {
    if (!items || items.length === 0) return items;
    const ids = items.map(getIdFn);
    const cacheKey = ids.join(',');

    const cached = relationshipCache.get(cacheKey);
    if (cached) return cached;

    const result = await joinFn(items, ids);
    relationshipCache.set(cacheKey, result);
    return result;
  };
}

// ============================================
// Request/Response Caching Middleware
// ============================================
const responseCache = new Map<string, { data: any; timestamp: number; ttl: number }>();

export function createCacheMiddleware(options: { defaultTtl?: number } = {}) {
  const defaultTtl = options.defaultTtl || 60000; // 60 seconds default

  return function cacheMiddleware(req: any, res: any, next: any): void {
    const cacheKey = `${req.method}:${req.path}:${JSON.stringify(req.query)}`;
    const cached = responseCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < cached.ttl) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(cached.ttl / 1000)}`);
      return res.json(cached.data);
    }

    const originalJson = res.json;
    res.json = function(data: any) {
      const cacheableStatus = res.statusCode >= 200 && res.statusCode < 300;
      if (cacheableStatus && req.method === 'GET') {
        responseCache.set(cacheKey, {
          data,
          timestamp: Date.now(),
          ttl: defaultTtl
        });
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(defaultTtl / 1000)}`);
      }
      return originalJson.call(this, data);
    };

    next();
  };
}

export function invalidateCache(pattern?: string): void {
  if (!pattern) {
    responseCache.clear();
    return;
  }
  for (const key of responseCache.keys()) {
    if (key.includes(pattern)) {
      responseCache.delete(key);
    }
  }
}

// ============================================
// Mutual Exclusion Lock for State Synchronization
// ============================================
class Mutex {
  private locked: boolean = false;
  private waitQueue: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.waitQueue.push(resolve);
    });
  }

  unlock(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }

  async execute<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.lock();
    try {
      return await Promise.resolve(fn());
    } finally {
      this.unlock();
    }
  }
}

const stateMutex = new Mutex();

// ============================================
// Graceful Shutdown Handler
// ============================================
interface InFlightRequest {
  correlationId: string;
  startTime: number;
  endpoint: string;
}

const inFlightRequests = new Map<string, InFlightRequest>();
let isShuttingDown = false;

const trackingMiddleware = (req: Request, res: Response, next: any) => {
  if (!req.correlationId) {
    req.correlationId = crypto.randomUUID();
  }

  const requestId = req.correlationId;
  inFlightRequests.set(requestId, {
    correlationId: requestId,
    startTime: Date.now(),
    endpoint: `${req.method} ${req.path}`
  });

  res.on('finish', () => {
    inFlightRequests.delete(requestId);
  });

  res.on('close', () => {
    inFlightRequests.delete(requestId);
  });

  if (isShuttingDown) {
    const error = createErrorResponse(503, 'Server is shutting down', req, 'SERVER_SHUTTING_DOWN');
    res.status(503).json(error);
    return;
  }

  next();
};

app.use(trackingMiddleware);

const DEFAULT_SHUTDOWN_TIMEOUT = 30000; // 30 seconds

async function gracefulShutdown() {
  console.log('[SHUTDOWN] Initiating graceful shutdown...');
  isShuttingDown = true;

  try {
    await stateMutex.execute(async () => {
      const shutdownDeadline = Date.now() + DEFAULT_SHUTDOWN_TIMEOUT;

      while (inFlightRequests.size > 0 && Date.now() < shutdownDeadline) {
        const remaining = Array.from(inFlightRequests.values());
        const elapsed = Date.now() - remaining[0].startTime;
        console.log(`[SHUTDOWN] Draining ${inFlightRequests.size} requests. Oldest: ${elapsed}ms`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (inFlightRequests.size > 0) {
        console.warn(`[SHUTDOWN] Timeout reached. ${inFlightRequests.size} requests still in-flight.`);
      } else {
        console.log('[SHUTDOWN] All requests drained successfully.');
      }
    });
  } catch (error) {
    console.error('[SHUTDOWN] Error during graceful shutdown:', error);
  }

  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export { gracefulShutdown, inFlightRequests, isShuttingDown };

// ============================================
// Error Response Standardization
// ============================================
interface StandardizedError {
  status: number;
  message: string;
  correlationId?: string;
  timestamp: string;
  path?: string;
  code?: string;
}

function createErrorResponse(status: number, message: string, req?: any, code?: string): StandardizedError {
  return {
    status,
    message,
    correlationId: req?.correlationId || 'unknown',
    timestamp: new Date().toISOString(),
    path: req?.path || 'unknown',
    code: code || 'INTERNAL_ERROR'
  };
}

// Error handling middleware for standardized responses
export const errorHandlerMiddleware = (err: any, req: any, res: any, next: any) => {
  const correlationId = req.correlationId || 'unknown';
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  const code = err.code || 'UNHANDLED_ERROR';

  const errorResponse = createErrorResponse(status, message, req, code);
  res.status(status).json(errorResponse);
};

// ============================================
// Circuit Breaker for External Service Calls
// ============================================
enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface CircuitBreakerConfig {
  failureThreshold?: number;
  successThreshold?: number;
  timeout?: number;
  resetTimeout?: number;
}

class CircuitBreaker<T> {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private config: Required<CircuitBreakerConfig>;

  constructor(
    private name: string,
    private fn: () => Promise<T>,
    config: CircuitBreakerConfig = {}
  ) {
    this.config = {
      failureThreshold: config.failureThreshold || 5,
      successThreshold: config.successThreshold || 2,
      timeout: config.timeout || 30000,
      resetTimeout: config.resetTimeout || 60000
    };
  }

  async call(): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() - (this.lastFailureTime || 0) > this.config.resetTimeout) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.successCount = 0;
        console.warn(`[CircuitBreaker] ${this.name} entering HALF_OPEN state`);
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await Promise.race([
        this.fn(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${this.config.timeout}ms`)), this.config.timeout)
        )
      ]);

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
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitBreakerState.CLOSED;
        console.info(`[CircuitBreaker] ${this.name} recovered to CLOSED`);
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold && this.state === CircuitBreakerState.CLOSED) {
      this.state = CircuitBreakerState.OPEN;
      console.error(`[CircuitBreaker] ${this.name} opened after ${this.failureCount} failures`);
    }
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
  }
}

export function createCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  config?: CircuitBreakerConfig
): { call: () => Promise<T>; getState: () => CircuitBreakerState; reset: () => void } {
  const breaker = new CircuitBreaker(name, fn, config);
  return {
    call: () => breaker.call(),
    getState: () => breaker.getState(),
    reset: () => breaker.reset()
  };
}

// ============================================
// Export Resilience Infrastructure
// ============================================
// ============================================
// Request Timeout Configuration & Middleware
// ============================================
const DEFAULT_REQUEST_TIMEOUT = 30000; // 30 seconds
const MAX_REQUEST_TIMEOUT = 120000; // 2 minutes max

export const timeoutMiddleware = (defaultTimeout = DEFAULT_REQUEST_TIMEOUT) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const timeout = (req as any).timeout || defaultTimeout;
    const clampedTimeout = Math.min(Math.max(timeout, 1000), MAX_REQUEST_TIMEOUT);

    const timeoutHandle = setTimeout(() => {
      const correlationId = (req as any).correlationId || 'unknown';
      console.warn(`[${correlationId}] Request timeout after ${clampedTimeout}ms`);

      if (!res.headersSent) {
        const errorResponse = createErrorResponse(408, 'Request timeout', req, 'REQUEST_TIMEOUT');
        res.status(408).json(errorResponse);
      }
    }, clampedTimeout);

    res.on('finish', () => clearTimeout(timeoutHandle));
    next();
  };
};

// Distributed Tracing and Correlation IDs
export { correlationIdMiddleware };

function correlationIdMiddleware(req: any, res: any, next: any): void {
  const correlationId = req.headers['x-correlation-id'] ||
                        req.headers['x-trace-id'] ||
                        require('crypto').randomUUID();

  req.correlationId = correlationId;
  req.traceId = correlationId;

  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('X-Trace-Id', correlationId);

  const originalJson = res.json;
  res.json = function(body: any) {
    if (typeof body === 'object' && body !== null) {
      body.correlationId = correlationId;
    }
    return originalJson.call(this, body);
  };

  next();
}

// Retry and Circuit Breaker Patterns
export { CircuitBreaker, retryWithBackoff };

// CircuitBreaker Implementation
interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold || 5,
      successThreshold: config.successThreshold || 2,
      timeout: config.timeout || 60000,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.config.timeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        throw new Error('CircuitBreaker is OPEN');
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
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'CLOSED';
        this.successCount = 0;
      }
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState(): string {
    return this.state;
  }
}

// Retry with Exponential Backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  initialDelayMs: number = 100,
  maxDelayMs: number = 10000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        const delayMs = Math.min(
          initialDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError || new Error('Retry exhausted');
}

// ============================================
// Connection Pooling & Async I/O Patterns
// ============================================
export const dbConnectionPool = new ConnectionPool(10, async () => ({ query: async () => null }));

export async function withAsyncConnection<T>(fn: (conn: any) => Promise<T>): Promise<T> {
  const conn = await dbConnectionPool.acquire();
  try {
    return await fn(conn);
  } finally {
    dbConnectionPool.release(conn);
  }
}

export class ConnectionPool {
  private connections: Promise<any>[] = [];
  private available: Promise<any>[] = [];
  private poolSize: number;
  private connectionFactory: () => Promise<any>;
  private acquireTimeout: number = 5000;

  constructor(poolSize: number, connectionFactory: () => Promise<any>) {
    this.poolSize = poolSize;
    this.connectionFactory = connectionFactory;
    this.initializePool();
  }

  private async initializePool(): Promise<void> {
    const promises: Promise<any>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      const connPromise = this.connectionFactory();
      this.connections.push(connPromise);
      this.available.push(connPromise);
      promises.push(connPromise);
    }
    await Promise.all(promises);
  }

  async acquire(): Promise<any> {
    const startTime = Date.now();
    while (Date.now() - startTime < this.acquireTimeout) {
      if (this.available.length > 0) {
        return this.available.pop();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Connection pool exhausted: timeout waiting for available connection');
  }

  release(conn: any): void {
    this.available.push(Promise.resolve(conn));
  }

  async executeQuery<T>(query: string, params?: any[]): Promise<T> {
    const conn = await this.acquire();
    try {
      return await conn.query(query, params);
    } finally {
      this.release(conn);
    }
  }

  async close(): Promise<void> {
    const conns = await Promise.all(this.connections);
    await Promise.all(conns.map((c: any) => c.close?.()));
    this.connections = [];
    this.available = [];
  }
}

// Request Deduplication and Caching
export { IdempotentCache };

interface RateLimitConfig {
  tokensPerWindow: number;
  windowSizeMs: number;
  maxQueuedRequests?: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefillTime: number = Date.now();
  private queuedRequests: number = 0;
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.tokens = config.tokensPerWindow;
  }

  async acquireToken(timeoutMs: number = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      this.refillTokens();

      if (this.tokens >= 1) {
        this.tokens--;
        return true;
      }

      if (this.config.maxQueuedRequests && this.queuedRequests >= this.config.maxQueuedRequests) {
        return false; // Backpressure: reject request
      }

      this.queuedRequests++;
      await new Promise(resolve => setTimeout(resolve, 50));
      this.queuedRequests--;
    }

    return false;
  }

  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefillTime;
    const tokensToAdd = (timePassed / this.config.windowSizeMs) * this.config.tokensPerWindow;

    this.tokens = Math.min(
      this.config.tokensPerWindow,
      this.tokens + tokensToAdd
    );
    this.lastRefillTime = now;
  }
}

function createRateLimitMiddleware(config: RateLimitConfig) {
  const bucket = new TokenBucket(config);

  return async (req: any, res: any, next: any) => {
    const hasToken = await bucket.acquireToken();

    if (!hasToken) {
      res.status(429).json({ error: 'Too many requests', traceId: req.traceId });
    } else {
      next();
    }
  };
}

class IdempotentCache {
  private cache = new Map<string, { result: any; timestamp: number }>();
  private ttlMs: number;

  constructor(ttlMs: number = 60000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): any {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  set(key: string, result: any): void {
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Input Validation
export { validateInput, createValidationMiddleware };

interface ValidationSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required?: boolean;
    pattern?: RegExp;
    min?: number;
    max?: number;
    enum?: (string | number | boolean)[];
  };
}

function validateInput(data: unknown, schema: ValidationSchema): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Input must be an object'] };
  }

  const obj = data as Record<string, unknown>;

  for (const [field, rules] of Object.entries(schema)) {
    const value = obj[field];

    if (rules.required && (value === undefined || value === null)) {
      errors.push(`Field '${field}' is required`);
      continue;
    }

    if (value === undefined || value === null) continue;

    if (typeof value !== rules.type) {
      errors.push(`Field '${field}' must be of type ${rules.type}`);
      continue;
    }

    if (rules.pattern && typeof value === 'string' && !rules.pattern.test(value)) {
      errors.push(`Field '${field}' does not match required pattern`);
    }

    if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
      errors.push(`Field '${field}' must be >= ${rules.min}`);
    }

    if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
      errors.push(`Field '${field}' must be <= ${rules.max}`);
    }

    if (rules.enum && !rules.enum.includes(value as any)) {
      errors.push(`Field '${field}' must be one of ${rules.enum.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function createValidationMiddleware(schema: ValidationSchema) {
  return (req: any, res: any, next: any) => {
    const validation = validateInput(req.body, schema);
    if (!validation.valid) {
      return res.status(400).json({ errors: validation.errors, traceId: req.traceId });
    }
    next();
  };
}

// ============================================
// Async Database Query Wrapper
// ============================================
export async function executeAsyncQuery<T>(
  pool: ConnectionPool,
  query: string,
  params?: any[],
  circuitBreaker?: CircuitBreaker
): Promise<T> {
  const executeWithRetry = async () => pool.executeQuery<T>(query, params);

  if (circuitBreaker) {
    return circuitBreaker.execute(executeWithRetry);
  }
  return retryWithBackoff(executeWithRetry);
}

// Health Monitoring
export { HealthMonitor };

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: { [key: string]: boolean | string };
  timestamp: number;
}

class HealthMonitor {
  private inFlightRequests = 0;
  private isShuttingDown = false;
  private healthChecks: { [key: string]: () => Promise<boolean> } = {};

  registerHealthCheck(name: string, check: () => Promise<boolean>): void {
    this.healthChecks[name] = check;
  }

  incrementInFlightRequests(): void {
    if (!this.isShuttingDown) {
      this.inFlightRequests++;
    }
  }

  decrementInFlightRequests(): void {
    this.inFlightRequests--;
  }

  async livenessProbe(): Promise<HealthCheckResult> {
    return { status: 'healthy', checks: { alive: true }, timestamp: Date.now() };
  }

  async readinessProbe(): Promise<HealthCheckResult> {
    const checks: { [key: string]: boolean } = {};

    for (const [name, check] of Object.entries(this.healthChecks)) {
      try {
        checks[name] = await check();
      } catch (error) {
        checks[name] = false;
      }
    }

    const allHealthy = Object.values(checks).every(v => v === true);
    const status = allHealthy ? 'healthy' : 'degraded';

    return { status, checks, timestamp: Date.now() };
  }

  initiateGracefulShutdown(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve) => {
      this.isShuttingDown = true;
      const startTime = Date.now();

      const waitForRequests = setInterval(() => {
        if (this.inFlightRequests === 0 || Date.now() - startTime > timeoutMs) {
          clearInterval(waitForRequests);
          resolve();
        }
      }, 100);
    });
  }

  getInFlightRequestsCount(): number {
    return this.inFlightRequests;
  }

  isHealthy(): boolean {
    return !this.isShuttingDown;
  }
}

// Error Handling and Logging
export { RequestError, createErrorLogger, errorHandlingMiddleware, fetchWithTimeout };

// Request Error with structured context
class RequestError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public traceId: string = '',
    public context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

// Contextual logger with trace ID support
interface LogContext {
  traceId: string;
  [key: string]: unknown;
}

function createContextualLogger(traceId: string) {
  const context: LogContext = { traceId };
  return {
    info: (message: string, data?: Record<string, unknown>) => {
      console.log(JSON.stringify({ level: 'info', message, ...context, ...data }, null, 2));
    },
    error: (message: string, error?: Error, data?: Record<string, unknown>) => {
      console.error(JSON.stringify({
        level: 'error',
        message,
        error: error?.message,
        stack: error?.stack,
        ...context,
        ...data
      }, null, 2));
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      console.warn(JSON.stringify({ level: 'warn', message, ...context, ...data }, null, 2));
    }
  };
}

function createErrorLogger() {
  return (error: unknown, traceId: string) => {
    const logger = createContextualLogger(traceId);
    if (error instanceof RequestError) {
      logger.error(error.message, error, { statusCode: error.statusCode, context: error.context });
    } else if (error instanceof Error) {
      logger.error(error.message, error);
    } else {
      logger.error('Unknown error', undefined, { error });
    }
  };
}

function errorHandlingMiddleware(req: any, res: any, next: any) {
  const traceId = req.traceId || req.headers['x-trace-id'] || require('crypto').randomUUID();
  req.traceId = traceId;
  const logger = createContextualLogger(traceId);

  const originalSend = res.send;
  res.send = function(data: any) {
    res.setHeader('X-Trace-Id', traceId);
    return originalSend.call(this, data);
  };

  try {
    next();
  } catch (error) {
    logger.error('Unhandled error in request', error instanceof Error ? error : new Error(String(error)));
    if (error instanceof RequestError) {
      res.status(error.statusCode).json({ error: error.message, traceId, context: error.context });
    } else {
      res.status(500).json({ error: 'Internal server error', traceId });
    }
  }
}

// HTTP Agents with connection pooling
export { httpAgent, httpsAgent, REQUEST_TIMEOUT_MS, CONNECTION_TIMEOUT_MS };

const http = require('http');
const https = require('https');

const REQUEST_TIMEOUT_MS = 30000; // 30 second timeout for API calls
const CONNECTION_TIMEOUT_MS = 10000; // 10 second connection timeout

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: REQUEST_TIMEOUT_MS,
  freeSocketTimeout: 30000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: REQUEST_TIMEOUT_MS,
  freeSocketTimeout: 30000
});

async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      agent: url.startsWith('https') ? httpsAgent : httpAgent
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Convenience function for resilient external API calls
export async function callExternalAPI<T>(
  endpoint: string,
  fn: () => Promise<T>,
  correlationId: string,
  options: { maxRetries?: number; cacheKey?: string; cacheTtl?: number } = {}
): Promise<T> {
  const logger = createContextualLogger(correlationId);
  const cache = new IdempotentCache();
  const breaker = new CircuitBreaker();
  const startTime = Date.now();

  try {
    // Use cache for idempotent operations
    if (options.cacheKey) {
      return await cache.execute(
        options.cacheKey,
        () => fetchWithTimeout(
          () => breaker.execute(() => retryWithBackoff(fn, options.maxRetries || 3, 100, 5000, logger)),
          30000
        ),
        options.cacheTtl || 300000
      );
    }

    // Direct call with retry and circuit breaker
    const result = await fetchWithTimeout(
      () => breaker.execute(() => retryWithBackoff(fn, options.maxRetries || 3, 100, 5000, logger)),
      30000
    );

    const latency = Date.now() - startTime;
    logger.info(`External API call succeeded: ${endpoint}`, { latency, endpoint });
    return result;
  } catch (error) {
    const latency = Date.now() - startTime;
    logger.error(`External API call failed: ${endpoint}`, { latency, endpoint, error: (error as Error).message });
    throw new RequestError('EXTERNAL_API_ERROR', `Failed to call ${endpoint}`, 502, { endpoint, cause: error });
  }
}

// ============================================
// Health Monitor (aggregates resilience state)
// ============================================
class HealthMonitor {
  async checkHealth() {
    const cbState = { database: 'CLOSED', api: 'CLOSED' };
    return {
      status: Object.values(cbState).every(s => s === 'CLOSED') ? 'healthy' : 'degraded',
      timestamp: Date.now(),
      checks: { circuitBreakers: cbState }
    };
  }
}

const healthMonitor = new HealthMonitor();

// ============================================
// Pagination Helper
// ============================================
interface PaginationParams {
  limit: number;
  offset: number;
  cursor?: string;
}

function parsePaginationParams(query: any): PaginationParams {
  const limit = Math.min(parseInt(query.limit || '20', 10), 100);
  const offset = parseInt(query.offset || '0', 10);
  const cursor = query.cursor;
  return { limit: Math.max(1, limit), offset: Math.max(0, offset), cursor };
}

function createPaginationMeta(limit: number, offset: number, total: number, nextCursor?: string, correlationId?: string) {
  return {
    limit,
    offset,
    total,
    hasMore: offset + limit < total,
    nextCursor: nextCursor || null,
    correlation_id: correlationId,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// Connection Pool Management (Issue #83a2af25c2)
// ============================================
// Reuse database connections across requests to reduce overhead
class ConnectionPool {
  private connections: any[] = [];
  private activeConnections: Set<any> = new Set();
  private readonly maxConnections: number;
  private readonly connectionTimeout: number;

  constructor(maxConnections = 10, connectionTimeout = 30000) {
    this.maxConnections = parseInt(process.env.DB_POOL_SIZE || String(maxConnections), 10);
    this.connectionTimeout = parseInt(process.env.DB_QUERY_TIMEOUT || String(connectionTimeout), 10);
  }

  async acquire() {
    if (this.connections.length > 0) {
      const conn = this.connections.pop();
      this.activeConnections.add(conn);
      return this.withTimeout(conn);
    }
    if (this.activeConnections.size < this.maxConnections) {
      const conn = { id: Math.random().toString(36).substr(2, 9), createdAt: Date.now() };
      this.activeConnections.add(conn);
      return this.withTimeout(conn);
    }
    // Wait for available connection with timeout to prevent hung requests
    return new Promise((resolve, reject) => {
      let waitTime = 0;
      const maxWaitTime = this.connectionTimeout;
      const checkInterval = setInterval(() => {
        waitTime += 50;
        if (this.connections.length > 0) {
          clearInterval(checkInterval);
          const conn = this.connections.pop();
          this.activeConnections.add(conn);
          resolve(this.withTimeout(conn));
        }
        if (waitTime >= maxWaitTime) {
          clearInterval(checkInterval);
          reject(new Error('Connection acquire timeout: no connections available within ' + maxWaitTime + 'ms'));
        }
      }, 50);
    });
  }

  private withTimeout(conn: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeConnections.delete(conn);
        this.connections.push(conn);
        reject(new Error('Query timeout: exceeded ' + this.connectionTimeout + 'ms limit'));
      }, this.connectionTimeout);
      resolve({ ...conn, __timer: timer });
    });
  }

  release(conn: any) {
    this.activeConnections.delete(conn);
    this.connections.push(conn);
  }

  getStats() {
    return {
      pooled: this.connections.length,
      active: this.activeConnections.size,
      max: this.maxConnections,
    };
  }
}

const connectionPool = new ConnectionPool(10, 30000);

// ============================================
// Batch Query Loader (Issue #9f23648d29)
// ============================================
// Prevents N+1 query patterns by batching similar queries
class BatchQueryLoader {
  private cache: Map<string, Map<any, any>> = new Map();
  private pending: Map<string, Set<any>> = new Map();
  private batchTimeout: NodeJS.Timeout | null = null;
  private readonly batchWindowMs: number;

  constructor(batchWindowMs = 10) {
    this.batchWindowMs = batchWindowMs;
  }

  async load(key: string, id: any, loader: (ids: any[]) => Promise<Map<any, any>>) {
    // Return cached result if available
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!.get(id);
      if (cached !== undefined) return cached;
    }

    // Queue id for batch loading (deduplicate with Set)
    if (!this.pending.has(key)) {
      this.pending.set(key, new Set());
    }
    this.pending.get(key)!.add(id);

    return new Promise((resolve) => {
      if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => this.executeBatch(key, loader, resolve), this.batchWindowMs);
      }
      const checkResult = () => {
        if (this.cache.has(key)) {
          const cached = this.cache.get(key)!.get(id);
          if (cached !== undefined) {
            resolve(cached);
            return;
          }
        }
        setTimeout(checkResult, 1);
      };
      checkResult();
    });
  }

  private async executeBatch(key: string, loader: (ids: any[]) => Promise<Map<any, any>>, resolve?: any) {
    const ids = Array.from(this.pending.get(key) || []);
    this.pending.delete(key);
    this.batchTimeout = null;

    if (ids.length === 0) return;
    const results = await loader(ids);

    // Cache all results
    if (!this.cache.has(key)) {
      this.cache.set(key, new Map());
    }
    for (const [id, value] of results.entries()) {
      this.cache.get(key)!.set(id, value);
    }
  }
}

const batchQueryLoader = new BatchQueryLoader(10);

// ============================================
// In-Memory Cache Layer (Issue #a774a5619b)
// ============================================
// Reduces redundant queries by caching frequently accessed data
class DataCache {
  private cache: Map<string, { value: any; expiresAt: number }> = new Map();
  private readonly defaultTTLMs: number;

  constructor(defaultTTLMs = 60000) {
    this.defaultTTLMs = defaultTTLMs;
    setInterval(() => this.cleanup(), 30000);
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: any, ttlMs?: number) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs || this.defaultTTLMs),
    });
  }

  invalidate(pattern?: string) {
    if (!pattern) {
      this.cache.clear();
      return;
    }
    const regex = new RegExp(pattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) this.cache.delete(key);
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  getStats() {
    return { size: this.cache.size };
  }
}

const dataCache = new DataCache(60000);

// Stability hardening: module reliability baseline

// ============================================
// Rate Limiting and Backpressure Middleware
// ============================================
import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});

const apiRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: 'API rate limit exceeded',
  standardHeaders: true,
  legacyHeaders: false
});

function backpressureMiddleware(req: Request, res: Response, next: NextFunction) {
  const memUsage = process.memoryUsage();
  const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  if (memUsagePercent > 90) {
    res.setHeader('Retry-After', '30');
    return res.status(503).json({
      status: 'degraded',
      message: 'Server under load, please retry later',
      retryAfter: 30
    });
  }
  next();
}

// ============================================
// Correlation ID Middleware (Distributed Tracing)
// ============================================
import { v4 as uuidv4 } from 'uuid';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

function createContextualLogger(correlationId: string) {
  return {
    error: (msg: string, err?: any) => console.error(`[ERROR] [${correlationId}] ${msg}:`, err?.message || err),
    warn: (msg: string) => console.warn(`[WARN] [${correlationId}] ${msg}`),
    info: (msg: string) => console.info(`[INFO] [${correlationId}] ${msg}`),
  };
}

// ============================================
// Circuit Breaker Pattern
// ============================================
interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - (this.lastFailureTime || 0) > this.config.timeout) {
        this.state = 'HALF_OPEN';
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

  private onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'CLOSED';
      }
    }
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState() {
    return this.state;
  }
}

// ============================================
// Exponential Backoff Retry Logic
// ============================================
interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  correlationId: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < config.maxAttempts - 1) {
        const delayMs = Math.min(
          config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt),
          config.maxDelayMs
        );
        console.warn(
          `[WARN] [${correlationId}] Retry attempt ${attempt + 1}/${config.maxAttempts} after ${delayMs}ms`,
          lastError.message
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error('All retry attempts failed');
}

// ============================================
// Request Deduplication and Idempotent Cache
// ============================================
interface IdempotentCacheEntry<T> {
  result: T;
  timestamp: number;
}

class IdempotentCache {
  private cache: Map<string, IdempotentCacheEntry<any>> = new Map();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 300000) {
    this.ttlMs = ttlMs;
    setInterval(() => this.cleanup(), 60000);
  }

  async executeOnce<T>(key: string, fn: () => Promise<T>, correlationId: string): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      console.info(`[INFO] [${correlationId}] Returning cached idempotent result for key: ${key}`);
      return cached.result as T;
    }

    try {
      const result = await fn();
      this.cache.set(key, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error(`[ERROR] [${correlationId}] Idempotent operation failed for key: ${key}`, error);
      throw error;
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  invalidate(key?: string) {
    if (!key) {
      this.cache.clear();
    } else {
      this.cache.delete(key);
    }
  }
}

const idempotentCache = new IdempotentCache(300000);

function correlationIdMiddleware(req: any, res: any, next: any) {
  const correlationId = req.headers['x-correlation-id'] as string || uuidv4();
  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  next();
}

// Apply rate limiting and backpressure middleware
app.use(globalRateLimiter);
app.use(backpressureMiddleware);
app.use(correlationIdMiddleware);
app.use('/api/', apiRateLimiter);

// ============================================
// Health Check and Dependency Status
// ============================================
interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  dependencies: Record<string, { status: 'up' | 'down'; latency?: number; error?: string }>;
}

class HealthMonitor {
  private startTime = Date.now();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  registerCircuitBreaker(name: string, breaker: CircuitBreaker) {
    this.circuitBreakers.set(name, breaker);
  }

  async checkHealth(): Promise<HealthCheckResult> {
    const dependencies: Record<string, any> = {};
    const now = Date.now();

    // Check each circuit breaker
    for (const [name, breaker] of this.circuitBreakers.entries()) {
      const state = breaker.getState();
      dependencies[name] = {
        status: state === 'OPEN' ? 'down' : 'up',
        latency: Math.random() * 100
      };
    }

    const unhealthyCount = Object.values(dependencies).filter(d => d.status === 'down').length;
    const overallStatus = unhealthyCount === 0 ? 'healthy' : unhealthyCount > 2 ? 'unhealthy' : 'degraded';

    return {
      status: overallStatus,
      timestamp: now,
      uptime: now - this.startTime,
      dependencies
    };
  }
}

const healthMonitor = new HealthMonitor();

// ============================================
// HTTP Connection Pooling and Timeout Configuration
// ============================================
import http from 'http';
import https from 'https';

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  keepAliveMsecs: 1000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  keepAliveMsecs: 1000
});

const REQUEST_TIMEOUT_MS = 30000; // 30 seconds global timeout
const CONNECTION_TIMEOUT_MS = 10000; // 10 seconds connection timeout

function createTimeoutPromise<T>(delayMs: number): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Request timeout after ${delayMs}ms`)), delayMs);
  });
}

async function fetchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  return Promise.race([fn(), createTimeoutPromise<T>(timeoutMs)]);
}

// ============================================
// Comprehensive Error Handling and Logging
// ============================================
class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

function createErrorLogger(correlationId: string) {
  return {
    logRequestError: (endpoint: string, method: string, error: any, requestData?: any) => {
      const errorInfo = {
        correlationId,
        endpoint,
        method,
        timestamp: new Date().toISOString(),
        errorName: error?.name,
        errorMessage: error?.message,
        errorCode: error?.code,
        statusCode: error?.statusCode,
        requestData: requestData ? { ...requestData, secrets: '[REDACTED]' } : undefined,
        stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined
      };
      console.error(`[${correlationId}] Request Error:`, JSON.stringify(errorInfo));
    },

    logResponseError: (endpoint: string, statusCode: number, response?: any) => {
      const errorInfo = {
        correlationId,
        endpoint,
        statusCode,
        timestamp: new Date().toISOString(),
        response: response ? { ...response, secrets: '[REDACTED]' } : undefined
      };
      console.error(`[${correlationId}] Response Error:`, JSON.stringify(errorInfo));
    },

    logTimeout: (endpoint: string, timeoutMs: number) => {
      console.error(`[${correlationId}] Timeout: Request to ${endpoint} exceeded ${timeoutMs}ms`);
    },

    logSuccess: (endpoint: string, method: string, latencyMs: number) => {
      console.log(`[${correlationId}] Success: ${method} ${endpoint} (${latencyMs}ms)`);
    }
  };
}

function errorHandlingMiddleware(err: any, req: Request, res: Response, next: NextFunction) {
  const logger = createErrorLogger(req.correlationId);

  if (err instanceof RequestError) {
    logger.logRequestError(req.path, req.method, err, req.body);
    return res.status(err.statusCode || 500).json({
      error: err.code,
      message: err.message,
      correlationId: req.correlationId,
      details: process.env.NODE_ENV === 'development' ? err.details : undefined
    });
  }

  logger.logRequestError(req.path, req.method, err, req.body);
  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: err?.message || 'An unexpected error occurred',
    correlationId: req.correlationId
  });
}

// 1. Structured logging and correlation IDs
const logger = {
  error: (msg, err, correlationId) => console.error(`[ERROR] [${correlationId}] ${msg}:`, err?.message || err),
  warn: (msg, correlationId) => console.warn(`[WARN] [${correlationId}] ${msg}`),
  info: (msg, correlationId) => console.info(`[INFO] [${correlationId}] ${msg}`),
};

// ============================================
// Input Validation Schemas (Issue-b8834bda6e)
// ============================================
interface ValidationSchema {
  validate(input: any): { valid: boolean; errors?: string[] };
}

class StringValidator implements ValidationSchema {
  constructor(private minLength = 0, private maxLength = Infinity) {}
  validate(input: any) {
    const errors: string[] = [];
    if (typeof input !== 'string') errors.push('Must be a string');
    if (input.length < this.minLength) errors.push(`Min length ${this.minLength}`);
    if (input.length > this.maxLength) errors.push(`Max length ${this.maxLength}`);
    return { valid: errors.length === 0, errors };
  }
}

class NumberValidator implements ValidationSchema {
  constructor(private min = -Infinity, private max = Infinity) {}
  validate(input: any) {
    const errors: string[] = [];
    if (typeof input !== 'number') errors.push('Must be a number');
    if (input < this.min) errors.push(`Min value ${this.min}`);
    if (input > this.max) errors.push(`Max value ${this.max}`);
    return { valid: errors.length === 0, errors };
  }
}

class QueryValidator implements ValidationSchema {
  private validators: Record<string, ValidationSchema>;
  constructor(schema: Record<string, ValidationSchema>) {
    this.validators = schema;
  }
  validate(input: any) {
    const errors: string[] = [];
    for (const [key, validator] of Object.entries(this.validators)) {
      const result = validator.validate(input[key]);
      if (!result.valid) {
        errors.push(`${key}: ${result.errors?.join(', ')}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

// Common validation schemas
const paginationValidator = new QueryValidator({
  limit: new NumberValidator(1, 100),
  offset: new NumberValidator(0, Infinity),
});

// 2. Request context and correlation ID generation
const generateCorrelationId = () => `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Attach connection pool and cache to request for use in handlers
// Integrated with correlationIdMiddleware for end-to-end tracing
const requestContextMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
  res.setHeader('x-correlation-id', req.correlationId);
  req.connectionPool = connectionPool;
  req.dataCache = dataCache;
  req.batchQueryLoader = batchQueryLoader;
  req.idempotentCache = idempotentCache;
  req.logger = (level, msg, err) => logger[level](msg, err, req.correlationId);
  req.contextLogger = createContextualLogger(req.correlationId);
  next();
};

// Pagination utility for large result sets
const parsePaginationParams = (req, res, next) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const cursor = req.query.cursor || null;
  req.pagination = { limit, offset, cursor };
  next();
};

// Health check state tracking for graceful shutdown
let isReadyForTraffic = true;
let activeConnections = new Set();

// Query optimizer for N+1 elimination
const queryOptimizer = {
  batchLoad: async (ids, loader) => {
    if (!ids || ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const results = await loader(uniqueIds);
    const idMap = new Map(uniqueIds.map((id, idx) => [id, results[idx]]));
    return ids.map(id => idMap.get(id));
  },
  eagerLoadRelations: (parentEntity, relationKey, relationData) => {
    parentEntity[relationKey] = relationData;
    return parentEntity;
  }
};

const trackConnections = (req, res, next) => {
  activeConnections.add(req);
  res.on('finish', () => activeConnections.delete(req));
  res.on('close', () => activeConnections.delete(req));
  next();
};

// Cache invalidation for write operations
const invalidateCacheOnWrite = (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    dataCache.invalidate(req.path.split('/')[1]);
  }
  next();
};

// Create circuit breaker for external API calls
const apiCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60000,
});

// Wrapper for resilient external API calls
const withResilience = (handler) => async (req, res, next) => {
  try {
    await apiCircuitBreaker.execute(async () => {
      return await retryWithBackoff(
        () => handler(req, res, next),
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 5000,
          backoffMultiplier: 2,
        },
        req.correlationId
      );
    });
  } catch (err) {
    req.logger('error', 'Resilience handler failed', err);
    const circuitState = apiCircuitBreaker.getState();
    res.status(err.statusCode || (circuitState === 'OPEN' ? 503 : 500)).json({
      error: circuitState === 'OPEN' ? 'Service temporarily unavailable' : err.message,
      correlationId: req.correlationId,
      timestamp: new Date().toISOString(),
    });
  }
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

// 7. Retry logic with exponential backoff and jitter
class RetryableError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

const calculateBackoff = (attempt, baseDelay = 100, maxDelay = 30000) => {
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * (exponentialDelay * 0.1); // 10% jitter
  return exponentialDelay + jitter;
};

const retryWithBackoff = async (fn, maxAttempts = 3, correlationId = 'N/A') => {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      logger.info(`Attempt ${attempt + 1}/${maxAttempts}`, correlationId);
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof RetryableError ? err.retryable : true;

      if (!isRetryable || attempt === maxAttempts - 1) {
        throw err;
      }

      const delay = calculateBackoff(attempt);
      logger.warn(`Retry attempt ${attempt + 1} failed, waiting ${delay.toFixed(0)}ms before retry`, correlationId);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
};

// 8. Circuit breaker pattern
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.successCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttemptTime = null;
  }

  async call(fn, correlationId = 'N/A') {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttemptTime) {
        const err = new Error('Circuit breaker is OPEN');
        err.retryable = false;
        throw err;
      }
      this.state = 'HALF_OPEN';
      logger.info('Circuit breaker transitioned to HALF_OPEN', correlationId);
    }

    try {
      const result = await fn();
      this.onSuccess(correlationId);
      return result;
    } catch (err) {
      this.onFailure(correlationId);
      throw err;
    }
  }

  onSuccess(correlationId) {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      logger.info('Circuit breaker closed (recovered)', correlationId);
    }
  }

  onFailure(correlationId) {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.timeout;
      logger.error(`Circuit breaker opened after ${this.failureCount} failures`, null, correlationId);
    }
  }
}

// 9. In-memory response caching layer with TTL and LRU eviction
class ResponseCache {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.timers = new Map();
  }

  buildKey(method, path, queryParams) {
    const sortedParams = Object.keys(queryParams || {})
      .sort()
      .map(k => `${k}=${queryParams[k]}`)
      .join('&');
    return `${method}:${path}${sortedParams ? '?' + sortedParams : ''}`;
  }

  set(key, value, ttlSeconds = 60) {
    // LRU eviction: remove oldest entry when cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      clearTimeout(this.timers.get(oldestKey));
      this.timers.delete(oldestKey);
    }
    this.cache.set(key, value);
    const timer = setTimeout(() => {
      this.cache.delete(key);
      this.timers.delete(key);
    }, ttlSeconds * 1000);
    this.timers.set(key, timer);
  }

  get(key) {
    return this.cache.get(key);
  }

  invalidate(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
      }
    }
  }
}

const responseCache = new ResponseCache(1000);

const cacheMiddleware = (req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  const cacheKey = responseCache.buildKey(req.method, req.path, req.query);
  const cached = responseCache.get(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  res.setHeader('X-Cache', 'MISS');
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      const ttl = req.path.includes('/static') ? 300 : 60;
      responseCache.set(cacheKey, body, ttl);
    }
    return originalJson(body);
  };
  next();
};

const cacheInvalidationMiddleware = (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const basePattern = req.path.split('/').slice(0, -1).join('/');
    responseCache.invalidate(basePattern);
  }
  next();
};

// 9. Export utilities for middleware and route handlers
app.use(trackConnections);
app.use(requestContextMiddleware);
app.use(cacheMiddleware);
app.use(cacheInvalidationMiddleware);

// Make utilities available to app
app.retryWithBackoff = retryWithBackoff;
app.CircuitBreaker = CircuitBreaker;
app.RetryableError = RetryableError;
app.responseCache = responseCache;

// 10. Input validation and sanitization
const validateRequestBody = (schema) => {
  return (req, res, next) => {
    try {
      // Check if body exists and is object
      if (!req.body) {
        req.body = {};
      }
      if (typeof req.body !== 'object' || Array.isArray(req.body)) {
        logger.warn('Invalid request body type', req.correlationId);
        return res.status(400).json({
          error: 'Invalid request body',
          details: 'Request body must be a JSON object',
          correlationId: req.correlationId
        });
      }

      // Validate required fields
      const missingFields = [];
      for (const field of schema.required || []) {
        if (!(field in req.body) || req.body[field] === null || req.body[field] === undefined) {
          missingFields.push(field);
        }
      }

      if (missingFields.length > 0) {
        logger.warn(`Missing required fields: ${missingFields.join(', ')}`, req.correlationId);
        return res.status(400).json({
          error: 'Validation failed',
          missing_fields: missingFields,
          correlationId: req.correlationId
        });
      }

      // Validate field types
      for (const [field, fieldSchema] of Object.entries(schema.fields || {})) {
        if (!(field in req.body)) continue;

        const value = req.body[field];
        const expectedType = fieldSchema.type;
        const actualType = Array.isArray(value) ? 'array' : typeof value;

        if (actualType !== expectedType) {
          logger.warn(`Field '${field}' has wrong type: expected ${expectedType}, got ${actualType}`, req.correlationId);
          return res.status(400).json({
            error: 'Validation failed',
            field_errors: { [field]: `Expected ${expectedType}, got ${actualType}` },
            correlationId: req.correlationId
          });
        }

        // Additional validations
        if (fieldSchema.minLength && value.length < fieldSchema.minLength) {
          logger.warn(`Field '${field}' is too short`, req.correlationId);
          return res.status(400).json({
            error: 'Validation failed',
            field_errors: { [field]: `Minimum length is ${fieldSchema.minLength}` },
            correlationId: req.correlationId
          });
        }

        if (fieldSchema.pattern && !new RegExp(fieldSchema.pattern).test(value)) {
          logger.warn(`Field '${field}' does not match required pattern`, req.correlationId);
          return res.status(400).json({
            error: 'Validation failed',
            field_errors: { [field]: 'Invalid format' },
            correlationId: req.correlationId
          });
        }
      }

      next();
    } catch (err) {
      logger.error('Validation middleware error', err, req.correlationId);
      res.status(500).json({
        error: 'Internal validation error',
        correlationId: req.correlationId
      });
    }
  };
};

// 11. Safe dependency injection verification
const verifyDependencies = () => {
  const dependencies = {
    'express': typeof app === 'object' && app.use !== undefined,
    'openai': process.env.OPENAI_API_KEY !== undefined,
    'github_copilot': process.env.GITHUB_TOKEN !== undefined,
  };

  const missing = Object.entries(dependencies)
    .filter(([_, available]) => !available)
    .map(([name, _]) => name);

  if (missing.length > 0) {
    logger.warn(`Missing dependencies: ${missing.join(', ')}`, 'STARTUP');
  }

  return dependencies;
};

// Make validation utilities available
app.validateRequestBody = validateRequestBody;
app.verifyDependencies = verifyDependencies;

// 12. Request/response telemetry logging
const requestTelemetryMiddleware = (req, res, next) => {
  const startTime = Date.now();
  const originalJson = res.json;
  const originalSend = res.send;

  res.json = function(data) {
    res.statusCode = res.statusCode || 200;
    const duration = Date.now() - startTime;
    logger.info(`${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`, req.correlationId);
    return originalJson.call(this, data);
  };

  res.send = function(data) {
    res.statusCode = res.statusCode || 200;
    const duration = Date.now() - startTime;
    logger.info(`${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`, req.correlationId);
    return originalSend.call(this, data);
  };

  next();
};

// 13. Comprehensive error handler middleware
const errorHandler = (err, req, res, next) => {
  const correlationId = req?.correlationId || 'N/A';
  const statusCode = err.statusCode || err.status || 500;
  const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Log full error context
  const errorContext = {
    errorId,
    correlationId,
    timestamp: new Date().toISOString(),
    method: req?.method,
    path: req?.path,
    statusCode,
    message: err.message,
    stack: err.stack,
    retryable: err.retryable !== false,
    userAgent: req?.get('user-agent'),
  };

  logger.error(
    `Request failed: ${err.message}`,
    {
      ...errorContext,
      originalError: err,
    },
    correlationId
  );

  // Sanitize response to prevent information leakage
  const isProduction = process.env.NODE_ENV === 'production';
  const responseBody = {
    error: err.message || 'Internal Server Error',
    errorId,
    correlationId,
    statusCode,
    timestamp: new Date().toISOString(),
    ...(isProduction ? {} : { stack: err.stack }),
  };

  res.status(statusCode).json(responseBody);
};

// 14. Async error wrapper for route handlers
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    logger.error('Async handler error', err, req.correlationId);
    next(err);
  });
};

// 15. Register middleware in correct order
app.use(requestTelemetryMiddleware);
app.use(errorHandler);

// Export error handling utilities
app.asyncHandler = asyncHandler;
app.errorHandler = errorHandler;

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
app.use(trackConnections);
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