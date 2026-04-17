// In-memory cache for roasting profiles
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class ProfileCache {
  private cache = new Map<string, CacheEntry<any>>();
  private readonly defaultTTL = 5 * 60 * 1000; // 5 minutes in ms

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  set(key: string, data: any, ttl: number = this.defaultTTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
    } else {
      Array.from(this.cache.keys())
        .filter(key => key.includes(pattern))
        .forEach(key => this.cache.delete(key));
    }
  }

  invalidateKey(key: string): void {
    this.cache.delete(key);
  }
}

const profileCache = new ProfileCache();

import app from '../src/index.js';

export { profileCache };
export default app;