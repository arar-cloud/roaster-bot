/**
 * Batch query loader to prevent N+1 database problems
 * Collects individual entity requests and executes them as a single batch operation
 * Reduces database queries from O(n) to O(1)
 * Example: Loading 100 users individually = 100 queries. With batch loader = 1 query.
 */

type BatchFn<K, V> = (keys: K[]) => Promise<Map<K, V>>;

interface BatchLoadOptions {
  batchScheduleFn?: (callback: () => void) => void;
  cache?: boolean;
}

class DataLoader<K, V> {
  private batch: K[] = [];
  private promises: Promise<V>[] = [];
  private resolvers: Array<(value: V) => void> = [];
  private batchFn: BatchFn<K, V>;
  private batchScheduleFn: (callback: () => void) => void;
  private cache: Map<K, V> = new Map();
  private useCache: boolean;
  private isPending: boolean = false;

  constructor(batchFn: BatchFn<K, V>, options: BatchLoadOptions = {}) {
    this.batchFn = batchFn;
    this.batchScheduleFn = options.batchScheduleFn || ((cb) => setImmediate(cb));
    this.useCache = options.cache !== false;
  }

  /**
   * Load a single item - will be batched with other loads in the same tick
   * Returns immediately with a promise that resolves when batch executes
   */
  load(key: K): Promise<V> {
    // Check cache first - return resolved promise if found
    if (this.useCache && this.cache.has(key)) {
      return Promise.resolve(this.cache.get(key)!);
    }

    this.batch.push(key);

    let resolver: (value: V) => void;
    const promise = new Promise<V>((resolve) => {
      resolver = resolve;
    });

    this.resolvers.push(resolver!);
    this.promises.push(promise);

    // Schedule batch execution on first item
    if (this.batch.length === 1 && !this.isPending) {
      this.isPending = true;
      this.batchScheduleFn(() => this.dispatchBatch());
    }

    return promise;
  }

  /**
   * Load multiple items as a batch - more efficient than individual load() calls
   */
  loadMany(keys: K[]): Promise<V[]> {
    return Promise.all(keys.map((key) => this.load(key)));
  }

  /**
   * Execute the batched query - combines all collected keys into single operation
   */
  private async dispatchBatch(): Promise<void> {
    const batch = this.batch;
    const resolvers = this.resolvers;

    this.batch = [];
    this.promises = [];
    this.resolvers = [];
    this.isPending = false;

    try {
      // Execute single batch operation for all collected keys
      const results = await this.batchFn(batch);

      // Resolve each promise with its corresponding result
      batch.forEach((key, index) => {
        const value = results.get(key);
        if (value !== undefined) {
          if (this.useCache) {
            this.cache.set(key, value);
          }
          resolvers[index](value);
        }
      });
    } catch (error) {
      // Propagate errors - in production, consider partial failures
      console.error('Batch loader error:', error);
      throw error;
    }
  }

  /**
   * Clear result cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size for monitoring
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}

export default DataLoader;