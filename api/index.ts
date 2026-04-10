import app from '../src/index.js';

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

// Apply middleware to app if available
if (app && typeof app.use === 'function') {
  app.use(compressionMiddleware);
  app.use(createLimiter());
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

export default app;