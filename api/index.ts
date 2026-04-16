import app from '../src/index.js';
import { verifySignatureAsync } from '../src/index.js';

// Pre-compiled token validation regex to eliminate multiple startsWith() calls
const TOKEN_REGEX = /^(sk_|pk_)[a-zA-Z0-9_-]{17,}$/; // Minimum 20 chars total

// LRU Cache with TTL and max size bound to prevent memory leaks
class BoundedLRUCache {
  private cache = new Map();
  private timestamps = new Map();
  private accessOrder = [];
  private maxSize = 500;
  private ttlMs = 10 * 60 * 1000; // 10 minutes

  set(key, value) {
    const now = Date.now();
    if (this.cache.has(key)) {
      this.accessOrder = this.accessOrder.filter(k => k !== key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used entry
      const lru = this.accessOrder.shift();
      this.cache.delete(lru);
      this.timestamps.delete(lru);
    }
    this.cache.set(key, value);
    this.timestamps.set(key, now);
    this.accessOrder.push(key);
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const timestamp = this.timestamps.get(key);
    if (Date.now() - timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.timestamps.delete(key);
      this.accessOrder = this.accessOrder.filter(k => k !== key);
      return null;
    }
    // Update access order for LRU
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
    return this.cache.get(key);
  }

  has(key) {
    return this.get(key) !== null;
  }
}

const tokenMetadataCache = new BoundedLRUCache(); // LRU cache with TTL and size bound

// Early-exit validation middleware with fail-fast pattern
const validateSecurityToken = (token) => {
  // Early exit 1: Check token existence
  if (!token) {
    return { valid: false, error: 'Token missing', statusCode: 401 };
  }
  
  // Check metadata cache first to avoid repeated validation
  if (tokenMetadataCache.has(token)) {
    return tokenMetadataCache.get(token);
  }
  
  // Early exit 2: Single regex check replaces multiple startsWith() + typeof/length checks
  if (!TOKEN_REGEX.test(token)) {
    const result = { valid: false, error: 'Invalid token format or prefix', statusCode: 400 };
    tokenMetadataCache.set(token, result);
    return result;
  }
  
  // Only run expensive crypto operations after basic checks pass
  return { valid: true };
};

// In-memory policy cache with TTL
class PolicyCache {
  constructor(ttlMs = 60000) {
    this.cache = new Map();
    this.ttl = ttlMs;
  }
  
  set(key, value) {
    const expiryTime = Date.now() + this.ttl;
    this.cache.set(key, { value, expiryTime });
  }
  
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiryTime) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.value;
  }
  
  clear() {
    this.cache.clear();
  }
}

const policyCache = new PolicyCache(60000); // 60-second TTL

// Policy lookup with caching
const getSecurityPolicy = (policyId, scope) => {
  const cacheKey = `policy:${policyId}:${scope}`;
  const cached = policyCache.get(cacheKey);
  
  if (cached) {
    return cached; // Return reference directly instead of spreading
  }
  
  // Simulate policy engine/database lookup
  const policy = {
    id: policyId,
    scope,
    permissions: ['read', 'write'],
    timestamp: Date.now()
  };
  
  policyCache.set(cacheKey, policy);
  return policy;
};

// Middleware factory with early exit enforcement and async crypto
const securityMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  const validation = validateSecurityToken(token);
  
  if (!validation.valid) {
    return res.status(validation.statusCode).json({ error: validation.error });
  }
  
  try {
    const publicKey = process.env.PUBLIC_KEY || 'default-key';
    const isSignatureValid = await verifySignatureAsync(token, token, publicKey);
    
    if (!isSignatureValid) {
      return res.status(401).json({ error: 'Invalid token signature' });
    }
    
    req.token = token;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Crypto verification failed', details: err.message });
  }
};

app.use(securityMiddleware);

export default app;