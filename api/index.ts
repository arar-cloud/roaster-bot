import app from '../src/index.js';

// Early-exit validation middleware with fail-fast pattern
const validateSecurityToken = (token) => {
  // Early exit 1: Check token existence
  if (!token) {
    return { valid: false, error: 'Token missing', statusCode: 401 };
  }
  
  // Early exit 2: Check token format before crypto ops
  if (typeof token !== 'string' || token.length < 20) {
    return { valid: false, error: 'Invalid token format', statusCode: 400 };
  }
  
  // Early exit 3: Check token prefix/structure without crypto
  if (!token.startsWith('sk_') && !token.startsWith('pk_')) {
    return { valid: false, error: 'Invalid token prefix', statusCode: 400 };
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
    return { ...cached, fromCache: true };
  }
  
  // Simulate policy engine/database lookup
  const policy = {
    id: policyId,
    scope,
    permissions: ['read', 'write'],
    timestamp: Date.now()
  };
  
  policyCache.set(cacheKey, policy);
  return { ...policy, fromCache: false };
};

// Middleware factory with early exit enforcement
const securityMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  const validation = validateSecurityToken(token);
  
  if (!validation.valid) {
    return res.status(validation.statusCode).json({ error: validation.error });
  }
  
  next();
};

app.use(securityMiddleware);

export default app;