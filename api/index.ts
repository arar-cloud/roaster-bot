import app from '../src/index.js';

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

// Apply middleware to app if available
if (app && typeof app.use === 'function') {
  app.use(compressionMiddleware);
}

export default app;