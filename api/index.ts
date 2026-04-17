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