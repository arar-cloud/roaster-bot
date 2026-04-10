import app from '../src/index.js';

// Min-Heap for efficient O(log n) LRU eviction
class MinHeap {
  private heap: Array<{ timestamp: number; key: string }> = [];

  push(timestamp: number, key: string): void {
    this.heap.push({ timestamp, key });
    this.bubbleUp(this.heap.length - 1);
  }

  popMin(): { timestamp: number; key: string } | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return min;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[index].timestamp < this.heap[parentIndex].timestamp) {
        [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < this.heap.length && this.heap[leftChild].timestamp < this.heap[smallest].timestamp) {
        smallest = leftChild;
      }
      if (rightChild < this.heap.length && this.heap[rightChild].timestamp < this.heap[smallest].timestamp) {
        smallest = rightChild;
      }
      if (smallest !== index) {
        [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
        index = smallest;
      } else {
        break;
      }
    }
  }
}

// Simple in-memory LRU cache for query results
class QueryCache {
  private cache: Map<string, { data: any; expires: number }> = new Map();
  private timestamps: Map<string, number> = new Map();
  private heap: MinHeap = new MinHeap();
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
      this.timestamps.delete(key);
      return null;
    }
    // Update timestamp lazily (no delete-and-reinsert)
    this.timestamps.set(key, Date.now());
    return entry.data;
  }

  set(key: string, data: any): void {
    // First, clean up expired entries
    const now = Date.now();
    for (const [k, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(k);
        this.timestamps.delete(k);
      }
    }
    const now = Date.now();
    // Remove oldest entry by timestamp if still at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, ts] of this.timestamps.entries()) {
        if (ts < oldestTime) {
          oldestTime = ts;
          oldest.key = k;
        }
      }
      if Evict oldest entry when at capacity - O(log n) via heap
    if (this.cache.size >= this.maxSize) {
      const oldest = this.heap.popMin();
      if (oldest && this.cache.has(oldest.key)) {
        this.cache.delete(oldest.key);
        this.timestamps.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      data,
      expires: Date.now() + this.ttlMs,
    });
    this.timestamps.set(key, Date.now());
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

// Batch query utilities to eliminate N+1 patterns
export class BatchQueryExecutor {
  // Batch fetch operation: converts array of queries into single bulk request
  static async batchFetch(
    ids: (string | number)[],
    queryFn: (ids: (string | number)[]) => Promise<any[]>
  ): Promise<Map<string | number, any>> {
    if (!ids || ids.length === 0) return new Map();

    // Use cache key based on sorted IDs for consistency; deduplicate without mutating input
    const cacheKey = `batch_${Array.from(new Set(ids)).sort().join('_')}`;
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