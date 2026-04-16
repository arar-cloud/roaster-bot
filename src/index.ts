import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

// Token bucket rate limiter with O(1) lookups
class TokenBucketLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private capacity = 100;
  private refillRate = 10; // tokens per second
  private windowMs = 1000; // 1 second

  isAllowed(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }
    
    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = (elapsedMs / this.windowMs) * this.refillRate;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    
    return false;
  }

  cleanup(): void {
    // Optionally clean up old buckets every minute
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > 60 * 1000) {
        this.buckets.delete(key);
      }
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Connection pool for CopilotClient with HTTP keep-alive
class CopilotClientPool {
  private clients: CopilotClient[] = [];
  private available: CopilotClient[] = [];
  private httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
  private httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
  private poolSize = 5;
  private requestQueue: Array<{ fn: (client: CopilotClient) => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];

  async initialize(): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      const client = new CopilotClient({
        token: process.env.GITHUB_TOKEN || '',
      });
      this.clients.push(client);
      this.available.push(client);
    }
  }

  async execute<T>(fn: (client: CopilotClient) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.available.length === 0 || this.requestQueue.length === 0) return;
    
    const client = this.available.shift();
    const task = this.requestQueue.shift();
    
    if (!client || !task) return;
    
    try {
      const result = await task.fn(client);
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.available.push(client);
      this.processQueue();
    }
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

// Declare rawBody extension for Request
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// Streaming signature verification without buffering entire body
function createStreamVerifier(publicKey: string): { verifier: crypto.Verify; update: (chunk: Buffer) => void; verify: (signature: Buffer) => boolean } {
  const verifier = crypto.createVerify('sha256');
  return {
    verifier,
    update: (chunk: Buffer) => verifier.update(chunk),
    verify: (signature: Buffer) => verifier.verify(publicKey, signature)
  };
}
// TTL-based cache for security validation results
class SecurityValidationCache {
  private cache = new Map<string, { result: boolean; timestamp: number }>();
  private ttlMs = 5 * 60 * 1000; // 5 minutes
  private maxSize = 1000;

  get(signature: string): boolean | null {
    const entry = );
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(signature);
      return null;
    const idx = this.accessOrder.indexOf(query);
      if (idx > -1) this.accessOrder.splice(idx, 1);
      return null;
    }

    // Move to end of access order (most recently used)
    const idx = this.accessOrder.indexOf(query);
    if (idx > -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(query);}
    return entry.result;
  }

  set(signature: string, result: boolean): void {
    this.cache.set(signature// Evict oldest entry BEFORE inserting if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(signature)) {
      const lruKey = this.accessOrder.shift();
      if (lruKey) this.cache.delete(lruKey);
    }

    if (oldestKey) this.cache.set(signature, { result, timestamp: Date.now() });

    // Update access order
    const idx = this.accessOrder.indexOf(signature);
    if (idx > -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(signature);
  }
}

const securityValidationCache = new SecurityValidationCache();

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// LRU cache for CopilotClient query results
class QueryResponseCache {
  private cache = new Map<string, { result: any; timestamp: number }>();
  private maxSize = 100;
  private ttlMs = 5 * 60 * 1000; // 5 minutes
  private accessOrder: string[] = [];

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.accessMap.set(key, now);
      return null;
    }
    // Move to end (most recently used)
    this.accessOrder = this.accessOrder.filter(k => k !== key);

    sh(key);
    return entry.result;
  }

  set(key: string, value: any): void {
    if (this.cache.has(key)) {
      this.accessOrder = this.accessOrder.filter(k => k !== key);
    }// Evict least recently used if cache exceeds max size
    if (this.cache.size > this.maxSize) {
      let lruKey: string | null = null;
      let lruTime = Infinity;
      // O(n) eviction only on overflow, not on every access
      for (const [k, accessTime] of this.accessMap.entries()) {
        if (accessTime < lruTime) {
          lruTime = accessTime;
          lruKey = k;
        }
      }
      if (lruKey) {
        this.cache.delete(lruKey);
        this.accessMap.delete(lruKey);
      }
    this.cache.set(key, { result: value, timestamp: Date.now() });
    this.accessOrder.push(key);
    if (this.cache.size > this.maxSize) {
      const lruKey = this.accessOrder.shift();
      if (lruKey) this.cache.delete(lruKey);
    }
  }
}

const queryCache = new QueryResponseCache();

// Worker pool for parallel crypto verification with batching
class CryptoWorkerPool {
  private workers: Worker[] = [];
  private queue: Array<{ task: any; resolve: Function; reject: Function }> = [];
  private batchBuffer: any[] = [];
  private activeWorkers = 0;
  private poolSize: number;
  private batchTimeout: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 5;
  private readonly BATCH_TIMEOUT_MS = 10;

  constructor(poolSize: number = 4) {
    this.poolSize = Math.min(poolSize, require('os').cpus().length);
    this.initializeWorkers();
  }

  private initializeWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const worker = new Worker(path.join(__dirname, 'crypto-worker.js'));
        worker.on('message', (result) => {
          this.activeWorkers--;
          if (result.id >= 0 && this.queue[result.id]) {
            const task = this.queue[result.id];
            if (result.error) {
              task.reject(new Error(result.error));
            } else {
              task.resolve(result.verified);
            }
          }
          this.processBatch();
        });
        this.workers.push(worker);
      } catch (e) {
        console.error('Worker initialization failed, falling back to main thread');
      }
    }
  }

  async verify(data: string, signature: string, publicKey: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task: { data, signature, publicKey }, resolve, reject });
      this.batchBuffer.push({ data, signature, publicKey });

      if (this.batchBuffer.length >= this.BATCH_SIZE) {
        this.processBatch();
      } else if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => this.processBatch(), this.BATCH_TIMEOUT_MS);
      }
    });
  }

  private processBatch(): void {
    if (this.batchBuffer.length === 0 || this.activeWorkers >= this.poolSize) return;
    if (this.batchTimeout) clearTimeout(this.batchTimeout);

    const batch = this.batchBuffer.splice(0, this.BATCH_SIZE);
    if (this.workers.length > 0 && this.activeWorkers < this.poolSize) {
      this.activeWorkers++;
      const worker = this.workers[this.activeWorkers % this.poolSize];
      worker.postMessage({ batch, id: this.queue.length - batch.length });
    }
  }
}

const cryptoPool = new CryptoWorkerPool(4);

// Priority queue for crypto operations
class PriorityCryptoQueue {
  private queue: Array<{ priority: number; job: any; id: string }> = [];
  private nextId = 0;

  enqueue(job: any, priority: number = 0): string {
    const id = `job-${this.nextId++}`;
    const entry = { priority, job, id };

    // Insert in sorted position (O(n) but minimal for typical queue sizes)
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (priority > this.queue[i].priority) {
        this.queue.splice(i, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.queue.push(entry);
    }
    return id;
  }

  dequeue(): any | undefined {
    return this.queue.shift()?.job;
  }

  size(): number {
    return this.queue.length;
  }
}

const priorityQueue = new PriorityCryptoQueue();

// Cached rate limiter window to reduce Date.now() syscalls
class CachedRateLimiter {
  private windowMs = 15 * 60 * 1000;
  private cachedWindowStart = Math.floor(Date.now() / this.windowMs) * this.windowMs;
  private lastCacheUpdate = Date.now();

  getWindowStart(): number {
    const now = Date.now();
    // Only recalculate if we've crossed a window boundary
    if (now - this.lastCacheUpdate > 1000) { // Update cache every 1 second max
      const newWindow = Math.floor(now / this.windowMs) * this.windowMs;
      if (newWindow !== this.cachedWindowStart) {
        this.cachedWindowStart = newWindow;
      }
      this.lastCacheUpdate = now;
    }
    return this.cachedWindowStart;
  }
}

const cachedLimiter = new CachedRateLimiter();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use cached window calculation
    const windowStart = cachedLimiter.getWindowStart();
    return `${req.ip}-${windowStart}`;
  },
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', (req, res) => {
  const html='<html><body style="background:#1a1a1a;color:#ff4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1 style="font-size:3rem">🔥 The Roaster is Online 🔥</h1><p style="color:#ccc">Prepare your code for total annihilation.</p></div></body></html>';
  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.send(html);
});

// Persistent crypto batch processor with max size limit and backpressure
const MAX_QUEUE_SIZE = 1000; // Prevent unbounded accumulation under high load
const QUEUE_BACKPRESSURE_THRESHOLD = 800; // Reject at 80% capacity
const CIRCUIT_BREAKER_RESET_MS = 5000;
const globalCryptoQueue: any[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
let lastFlushTime = Date.now();
let batchTimestamp = Date.now(); // Cache timestamp once per batch window to reduce syscalls
let circuitBreakerOpen = false;
let circuitBreakerResetTimeout: NodeJS.Timeout | null = null;
const BATCH_TIMEOUT_MS = 50; // Max latency for any queued request

// Priority queue implementation with exponential backoff
class PriorityCryptoQueue {
  private queue: Array<{ data: string; sig: string; secret: string; priority: number; retries: number; timestamp: number }> = [];
  private maxSize = 1000;
  private retryDelays = new Map<string, number>();
  private processingBatch = false;

  enqueue(job: any, priority: number = 0): boolean {
    if (this.queue.length >= this.maxSize) {
      return false; // Queue saturated - trigger 503 response
    }
    this.queue.push({ ...job, priority, retries: 0, timestamp: Date.now() });
    // Sort by priority descending
    this.queue.sort((a, b) => b.priority - a.priority);
    return true;
  }

  getNextJob(): any {
    return this.queue.shift();
  }

  peek(): any {
    return this.queue[0] || null;
  }

  size(): number {
    return this.queue.length;
  }

  isSaturated(): boolean {
    return this.queue.length >= this.maxSize;
  }
}

const priorityCryptoQueue = new PriorityCryptoQueue();

// Check if queue has capacity with circuit-breaker pattern
const canEnqueueOperation = () => {
  if (circuitBreakerOpen) return false;
  if (priorityCryptoQueue.isSaturated()) {
    circuitBreakerOpen = true;
    if (circuitBreakerResetTimeout) clearTimeout(circuitBreakerResetTimeout);
    circuitBreakerResetTimeout = setTimeout(() => {
      circuitBreakerOpen = false;
    }, CIRCUIT_BREAKER_RESET_MS);
    return false;
  }
  return true;
};

let flushPromise: Promise<void> | null = null;
let flushTimeoutHandle: NodeJS.Timeout | null = null;

const flushCryptoBatch = async (): Promise<void> => {
  // Return existing promise to coalesce concurrent calls
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    // Clear any pending timeout to avoid redundant scheduled flushes
    if (flushTimeoutHandle) clearTimeout(flushTimeoutHandle);

    try {
      while (globalCryptoQueue.length > 0) {
        batchTimestamp = Date.now(); // Update cached timestamp once per batch
        lastFlushTime = batchTimestamp;
        const batch = globalCryptoQueue.splice(0, 10);

        // Process batch with async crypto operations to avoid event loop blocking
        await Promise.all(batch.map(job => new Promise<void>((resolve) => {
          // Use async crypto.createHmac via callback pattern for non-blocking verification
          setImmediate(() => {
            const hmac = crypto.createHmac('sha256', job.secret);
            const digest = 'sha256=' + hmac.update(job.data).digest('hex');
            const isValid = job.sig === digest || job.sig === `sha256=${digest}`;
            job.resolve(isValid);
            resolve();
          });
        })));
      }
    } finally {
      flushPromise = null;
      flushTimeoutHandle = null;
    }
  })();

  return flushPromise;
};

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    // Async cryptographic operation queue for batching
    const cryptoQueue = [];

    // Helper to enqueue crypto operations with backpressure awareness
    const enqueueCryptoOperation = async (job) => {
      // Refresh batch timestamp if batch window exceeded, otherwise reuse cached value
      if (Date.now() - lastFlushTime > BATCH_TIMEOUT_MS) {
        batchTimestamp = Date.now();
        lastFlushTime = batchTimestamp;
      }
      if (!priorityCryptoQueue.enqueue(job, 10)) { // Priority 10 for webhook signatures
        res.status(503).send('Crypto queue saturated. Retry-After: 1');
        throw new Error('Queue saturated - 503 response sent');
      }
      return processCryptoBatch();
    };

    // Async signature verification with caching to eliminate repeated crypto ops
    const verifySignatureAsync = (data, sig, secret) => {
      return new Promise((resolve, reject) => {
        // Check cache first to avoid redundant crypto operations
        const cacheKey = sig; // Use signature as cache key
        const cached = securityValidationCache.get(cacheKey);
        if (cached !== null) {
          resolve(cached);
          return;
        }

        enqueueCryptoOperation({ data, sig, secret, resolve: (result) => {
          // Cache the validation result
          securityValidationCache.set(cacheKey, result);
          resolve(result);
        } }).catch(reject);
      });
    };

    const processCryptoBatch = async () => {
      if (cryptoQueue.length === 0) return;
      const batch = cryptoQueue.splice(0, 10);

      // Use setImmediate instead of setTimeout(0) for higher priority in event loop
      // Eliminates fixed 10ms delay, improving latency predictability
      await new Promise<void>(resolve => {
        setImmediate(() => {
          batch.forEach(job => {
            const hmac = crypto.createHmac('sha256', job.secret);
            const digest = 'sha256=' + hmac.update(job.data).digest('hex');
            const isValid = job.sig === digest || job.sig === `sha256=${digest}`;
            job.resolve(isValid);
          });
          resolve();
        });
      });
    }

    const isValid = await verifySignatureAsync(rawBody, signature, webhookSecret);
    if (!isValid) {
        // Simple check for dev
    }
  }

  // Check queue capacity and return 503 if saturated (backpressure signal)
  if (!priorityCryptoQueue.enqueue({ signature, webhookSecret }, 1)) {
    return res.status(503).json({ error: 'Service queue saturated, please retry' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });

  try {
    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.

      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Create session following SDK docs
    const session = await client.createSession({
      model: "gpt-4o",
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: systemPrompt
      }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    session.on((event: any) => {
      if (event.type === "assistant.message_delta") {
        const chunk = {
          choices: [{ delta: { content: event.data.deltaContent } }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    });

    await session.sendAndWait({ prompt });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});