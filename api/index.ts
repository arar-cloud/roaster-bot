// Re-export app with caching utilities available
import app from '../src/index.js';

// Caching layer for reducing redundant API calls
interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

const requestCache = new Map<string, CacheEntry>();

/**
 * Generate cache key from request method, URL, and query params
 */
export function getCacheKey(method: string, url: string, query?: Record<string, any>): string {
  const queryStr = query ? JSON.stringify(query) : '';
  return `${method}:${url}:${queryStr}`;
}

/**
 * Store response in cache with TTL (Time To Live) in milliseconds
 * Default TTL: 60 seconds
 */
export function setCacheEntry(key: string, data: any, ttlMs: number = 60000): void {
  requestCache.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttlMs
  });
}

/**
 * Retrieve cached response if valid (not expired)
 */
export function getCacheEntry(key: string): any | null {
  const entry = requestCache.get(key);
  if (!entry) return null;
  
  const age = Date.now() - entry.timestamp;
  if (age > entry.ttl) {
    requestCache.delete(key);
    return null;
  }
  
  return entry.data;
}

/**
 * Invalidate cache for write operations (POST, PUT, DELETE)
 * Clears all cache entries for the base endpoint
 */
export function invalidateCache(baseUrl: string): void {
  const prefix = `${baseUrl}:`;
  for (const [key] of requestCache.entries()) {
    if (key.includes(prefix)) {
      requestCache.delete(key);
    }
  }
}

/**
 * Clear entire cache (use for debug/reset)
 */
export function clearCache(): void {
  requestCache.clear();
}

/**
 * Middleware factory for caching GET requests
 * Usage: app.get('/endpoint', cacheMiddleware(60000), handler)
 */
export function cacheMiddleware(ttlMs: number = 60000) {
  return (req: any, res: any, next: any) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }
    
    const cacheKey = getCacheKey(req.method, req.path, req.query);
    const cached = getCacheEntry(cacheKey);
    
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }
    
    // Store original json method
    const originalJson = res.json.bind(res);
    
    // Override json to cache response
    res.json = (data: any) => {
      setCacheEntry(cacheKey, data, ttlMs);
      res.set('X-Cache', 'MISS');
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * Batch Query Loader - Eliminates N+1 query patterns
 * Collects multiple ID requests and executes a single batch query
 */
export class BatchLoader<T, K = any> {
  private batch: Map<K, Promise<T>> = new Map();
  private batchFn: (ids: K[]) => Promise<Map<K, T>>;
  private batchSize: number;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(batchFn: (ids: K[]) => Promise<Map<K, T>>, batchSize: number = 100) {
    this.batchFn = batchFn;
    this.batchSize = batchSize;
  }

  /**
   * Queue a single item for batch loading
   * Returns a promise that resolves when batch is executed
   */
  async load(id: K): Promise<T> {
    // If batch is full, flush immediately
    if (this.batch.size >= this.batchSize) {
      await this.flush();
    }

    // If item already queued, return existing promise
    if (this.batch.has(id)) {
      return this.batch.get(id)!;
    }

    // Create promise for this item
    const promise = new Promise<T>(async (resolve, reject) => {
      // Schedule flush if not already scheduled
      if (!this.flushTimer) {
        this.flushTimer = setImmediate(async () => {
          try {
            await this.flush();
          } catch (e) {
            reject(e);
          }
        });
      }
    });

    this.batch.set(id, promise);
    return promise;
  }

  /**
   * Load multiple items at once
   */
  async loadMany(ids: K[]): Promise<T[]> {
    return Promise.all(ids.map(id => this.load(id)));
  }

  /**
   * Execute batch query and resolve all pending promises
   */
  private async flush(): Promise<void> {
    if (this.batch.size === 0) return;

    if (this.flushTimer) {
      clearImmediate(this.flushTimer);
      this.flushTimer = null;
    }

    const ids = Array.from(this.batch.keys());
    const currentBatch = this.batch;
    this.batch = new Map();

    try {
      const results = await this.batchFn(ids);
      
      // Resolve all promises with their results
      for (const [id, promise] of currentBatch.entries()) {
        const result = results.get(id);
        if (result !== undefined) {
          (promise as any).resolve?.(result);
        }
      }
    } catch (error) {
      // Reject all promises on error
      for (const [, promise] of currentBatch.entries()) {
        (promise as any).reject?.(error);
      }
      throw error;
    }
  }
}

/**
 * Eager load related entities to prevent N+1 queries
 * Usage: eagerLoad(items, 'userId', async ids => db.users.getMany(ids))
 */
export async function eagerLoad<T, K, R>(
  items: T[],
  relationKey: keyof T,
  loader: (ids: K[]) => Promise<Map<K, R>>
): Promise<Map<K, R>> {
  const ids = Array.from(new Set(
    items.map(item => item[relationKey] as K).filter(Boolean)
  ));
  
  if (ids.length === 0) return new Map();
  
  return loader(ids);
}

/**
 * Helper to attach loaded relations to items
 * Usage: attachRelations(items, 'userId', users, 'id', 'user')
 */
export function attachRelations<T extends Record<string, any>, R>(
  items: T[],
  relationKey: keyof T,
  loaded: Map<any, R>,
  idKey: string,
  attachKey: string
): T[] {
  return items.map(item => ({
    ...item,
    [attachKey]: loaded.get(item[relationKey])
  }));
}

export default app;