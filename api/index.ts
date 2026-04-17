// In-memory cache for roasting profiles
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// Database connection pool for query reuse
class DatabasePool {
  private connections = new Map<string, any>();
  private preparedStatements = new Map<string, any>();
  private readonly maxPoolSize = 5;
  private poolCount = 0;

  getConnection(dbUrl: string): any {
    if (!this.connections.has(dbUrl)) {
      if (this.poolCount < this.maxPoolSize) {
        const conn = { url: dbUrl, id: this.poolCount++ };
        this.connections.set(dbUrl, conn);
        return conn;
      }
      return this.connections.get(dbUrl);
    }
    return this.connections.get(dbUrl);
  }

  getPreparedStatement(sql: string): any {
    if (!this.preparedStatements.has(sql)) {
      this.preparedStatements.set(sql, { sql, compiled: true });
    }
    return this.preparedStatements.get(sql);
  }

  reset(): void {
    this.connections.clear();
    this.preparedStatements.clear();
    this.poolCount = 0;
  }
}

const dbPool = new DatabasePool();

class ProfileCache {
  private cache = new Map<string, CacheEntry<any>>();
  private keysByPrefix = new Map<string, Set<string>>();
  private readonly defaultTTL = 5 * 60 * 1000; // 5 minutes in ms
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const keysToDelete: string[] = [];
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.timestamp > entry.ttl) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => {
        this.cache.delete(key);
        const prefix = key.split(':')[0];
        this.keysByPrefix.get(prefix)?.delete(key);
      });
    }, 2 * 60 * 1000); // Run every 2 minutes
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

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
    const prefix = key.split(':')[0];
    if (!this.keysByPrefix.has(prefix)) {
      this.keysByPrefix.set(prefix, new Set());
    }
    this.keysByPrefix.get(prefix)!.add(key);
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
      this.keysByPrefix.clear();
    } else {
      const prefix = pattern.split(':')[0];
      const keysToDelete = this.keysByPrefix.get(prefix) || new Set();
      for (const key of keysToDelete) {
        this.cache.delete(key);
      }
      this.keysByPrefix.delete(prefix);
    }
  }

  invalidateKey(key: string): void {
    this.cache.delete(key);
    const prefix = key.split(':')[0];
    this.keysByPrefix.get(prefix)?.delete(key);
  }
}

const profileCache = new ProfileCache();

async function getProfileById(profileId: string) {
  const cacheKey = `profile:${profileId}`;
  
  // Check cache first
  const cached = profileCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Cache miss: fetch from database
  const profile = await db.query('SELECT * FROM roasting_profiles WHERE id = ?', [profileId]);
  
  // Store in cache for future requests
  if (profile) {
    profileCache.set(cacheKey, profile, 5 * 60 * 1000);
  }
  
  return profile;
}

async function updateProfile(profileId: string, updates: any) {
  const result = await db.query('UPDATE roasting_profiles SET ? WHERE id = ?', [updates, profileId]);
  
  // Invalidate cache on update
  profileCache.invalidateKey(`profile:${profileId}`);
  profileCache.invalidate('profileList');
  
  return result;
}

async function createProfile(data: any) {
  const result = await db.query('INSERT INTO roasting_profiles SET ?', [data]);
  
  // Invalidate list cache on creation
  profileCache.invalidate('profileList');
  
  return result;
}

async function deleteProfile(profileId: string) {
  const result = await db.query('DELETE FROM roasting_profiles WHERE id = ?', [profileId]);
  
  // Invalidate cache on deletion
  profileCache.invalidateKey(`profile:${profileId}`);
  profileCache.invalidate('profileList');
  
  return result;
}

import app from '../src/index.js';

export { profileCache, getProfileById, updateProfile, createProfile, deleteProfile };
export default app;