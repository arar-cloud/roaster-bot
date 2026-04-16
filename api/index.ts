import app from '../src/index.js';
import { verifySignatureAsync } from '../src/index.js';

// Pre-compiled token validation regex to eliminate alls
const TOKEN_REGEX = /^(sk_|pk_)[a-zA-Z0-9_-]{17,}$/; // Minimum 20 chars total

// Faster token validation using string primitives before regex
function validateTokenFormat(token: string): boolean {
  // Zero-allocation character comparison on hot path - avoid substring allocation
  if (token.length < 20) return false; // Minimum length check
  if (token[2] !== '_') return false; // Third char must be underscore
  
  const prefix2 = (token[0] === 's' && token[1] === 'k') || 
                  (token[0] === 'p' && token[1] === 'k');
  if (!prefix2) return false;
  
  // Only apply expensive regex if prefix matches
  return TOKEN_REGEX.test(token);
}

// LRU Cache with TTL and max size bound to prevent memory leaks
class BoundedLRUCache {
  private cache = new Map();
  private timestamps = new Map();
  private nodeMap = new Map<string, LRUNode>();
  private head: LRUNode | null = null;
  private tail: LRUNode | null = null;
  private headKey: string | null = null; // Track head key directly for O(1) lookup
  private maxSize = 500;
  private ttlMs = 10 * 60 * 1000; // 10 minutes
  private invalidationCallbacks = new Set<(key: string) => void>();
  private taskQueue: Array<{ fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  private activeWorkerCount = 0;
  private poolSize = 4;

  // Worker pool metrics and observability
  getMetrics() {
    return {
      queueLength: this.taskQueue.length,
      activeWorkerCount: this.activeWorkerCount,
      poolSize: this.poolSize,
      utilizationPercentage: (this.activeWorkerCount / this.poolSize) * 100,
      cacheSize: this.cache.size,
      maxCacheSize: this.maxSize
    };
  }

  private moveToEnd(node: LRUNode): void {
    if (!node || node === this.tail) return;
    // Unlink from current position
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
      if (this.head) this.headKey = this.head.key;
    }
    if (node.next) {
      node.next.prev = node.prev;
    }
    // Link to tail
    if (this.tail) {
      this.tail.next = node;
      node.prev = this.tail;
    } else {
      this.head = node;
      this.headKey = node.key;
    }
    node.next = null;
    this.tail = node;
  }

  private removeNode(node: LRUNode): void {
    if (node.prev) node.prev.next = node.next;
    else if (node === this.head) {
      this.head = node.next;
      this.headKey = node.next?.key || null;
    }
    if (node.next) node.next.prev = node.prev;
    else if (node === this.tail) this.tail = node.prev;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, timestamp] of this.timestamps.entries()) {
      if (now - timestamp > this.ttlMs) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this._evict(key);
    }
  }

  set(key, value) {
    const now = Date.now();
    
    // Lazy eviction: clean expired entries before inserting new ones
    this.cleanupExpired();
    
    if (this.nodeMap.has(key)) {
      const node = this.nodeMap.get(key)!;
      node.value = value;
      this.timestamps.set(key, now);
      this.moveToEnd(node);
    } else {
      if (this.cache.size >= this.maxSize && this.head) {
        // Evict least recently used entry using O(1) head tracking
        const lruKey = this.head.key;
        this.cache.delete(lruKey);
        this.timestamps.delete(lruKey);
        this.removeNode(this.head);
        this.nodeMap.delete(lruKey);
      }
      const newNode: LRUNode = { key, value, prev: this.tail, next: null };
      if (this.tail) this.tail.next = newNode;
      else this.head = newNode;
      this.cache.set(key, value);
      this.timestamps.set(key, now);
      this.nodeMap.set(key, newNode);
      this.tail = newNode;
      if (!this.headKey) this.headKey = newNode.key;
    }
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const timestamp = this.timestamps.get(key);
    if (Date.now() - timestamp! > this.ttlMs) {
      this._evict(key);
      return undefined;
    }
    const node = this.nodeMap.get(key)!;
    this.moveToEnd(node);
    return this.cache.get(key);
  }

  _evict(key): void {
    this.cache.delete(key);
    this.timestamps.delete(key);
    const node = this.nodeMap.get(key);
    if (node) {
      this.removeNode(node);
      this.nodeMap.delete(key);
    }
    this.invalidationCallbacks.forEach(cb => cb(key));
  }

  invalidate(key): void {
    this._evict(key);
  }

  onInvalidation(callback: (key: string) => void): void {
    this.invalidationCallbacks.add(callback);
  }

  has(key) {
    return this.get(key) !== null;
  }

  destroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.taskQueue = [];
    this.activeWorkerCount = 0;
  }
}

const tokenMetadataCache = new BoundedLRUCache(); // LRU cache with TTL and size bound

// Token revocation endpoint - enables immediate cache invalidation for security events
app.post('/revoke-token', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }
  tokenMetadataCache.invalidate(token);
  res.json({ status: 'revoked', timestamp: Date.now() });
});

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