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

export default app;