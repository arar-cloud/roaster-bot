import app from '../src/index.js';
import { verifySignatureAsync } from '../src/index.js';

// Pre-compiled token validation regex to eliminate multiple startsWith() calls
const TOKEN_REGEX = /^(sk_|pk_)[a-zA-Z0-9_-]{17,}$/; // Minimum 20 chars total
const tokenMetadataCache = new Map(); // Cache token validation metadata

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