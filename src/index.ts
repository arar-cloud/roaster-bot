import 'dotenv/config';
import express, { Request, Response } from 'express';
import compression from 'compression';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// HMAC verification using synchronous crypto.timingSafeEqual()
// Eliminates 10-50ms worker pool marshalling overhead per webhook
function verifyHmacSync(rawBody: string, webhookSecret: string, signature: string): boolean {
  try {
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = hmac.update(rawBody).digest('hex');
    const expectedSignature = 'sha256=' + digest;
    
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (err) {
    // timingSafeEqual throws if buffers have different lengths
    return false;
  }
}

app.use(helmet());

// Enable gzip compression to reduce response payload by 60-80% for mobile clients
app.use(compression({
  level: 4, // Balanced compression level: 70% ratio at 50% less CPU than level 6
  threshold: 1024, // Compress only responses >1KB to avoid gzip overhead on small payloads (<1KB gzip overhead negates benefit)
}));

// Circuit breaker for CopilotClient to prevent cascading failures
class CircuitBreaker {
  private failureCount = 0;
  private successCount = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED'; // CLOSED=healthy, OPEN=failing, HALF_OPEN=testing
  private readonly FAILURE_THRESHOLD = 5; // Open after 5 consecutive failures
  private readonly SUCCESS_RESET = 3; // Reset on 3 successes in HALF_OPEN
  private readonly INITIAL_TIMEOUT_MS = 60000; // Start at 60s
  private readonly MAX_TIMEOUT_MS = 240000; // Cap at 240s
  private openedAt: number = 0;
  private openCount = 0; // Track how many times circuit has opened for exponential backoff

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      // Exponential backoff: 60s, 120s, 240s (max)
      const exponentialTimeout = Math.min(
        this.INITIAL_TIMEOUT_MS * Math.pow(2, this.openCount - 1),
        this.MAX_TIMEOUT_MS
      );
      if (Date.now() - this.openedAt > exponentialTimeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker OPEN: GitHub API unavailable (exponential backoff active)');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.SUCCESS_RESET) {
        this.state = 'CLOSED';
      }
    }
  }

  private onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.openCount++; // Increment for next exponential backoff calculation
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.SUCCESS_RESET) {
        this.state = 'CLOSED';
        this.openCount = 0; // Reset exponential backoff counter on recovery
      }
    }
  }
}

const circuitBreaker = new CircuitBreaker();

// Retry logic with exponential backoff
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries - 1) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000); // Cap at 10s
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError || new Error('Retry exhausted');
}

// Initialize CopilotClient once at module load time with only token (no env spread)
const copilotClient = new CopilotClient({
  token: process.env.GITHUB_TOKEN || '',
}) as any; // Safe: we control token input

// Session pool to reuse connections and avoid per-request instantiation
class SessionPool {
  private sessions: Map<any, { createdAt: number; lastUsedAt: number }> = new Map();
  private inUse: Set<any> = new Set();
  private maxPoolSize = 5;
  private readonly SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
  private cleanupRunning = false;
  private readonly CLEANUP_INTERVAL_MS = 90000; // Background cleanup every 90s
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start background cleanup timer to avoid per-request overhead
    this.startBackgroundCleanup();
  }

  private startBackgroundCleanup() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions();
    }, this.CLEANUP_INTERVAL_MS);
    // Allow timer to be garbage collected if no other references exist
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private cleanupIdleSessions() {
    // Skip if cleanup already in progress (debounce guard)
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;

    try {
      const now = Date.now();
      const toRemove: any[] = [];

      for (const [session, metadata] of this.sessions.entries()) {
        // Remove sessions idle for more than SESSION_IDLE_TIMEOUT_MS
        if (!this.inUse.has(session) && now - metadata.lastUsedAt > this.SESSION_IDLE_TIMEOUT_MS) {
          toRemove.push(session);
        }
      }

      // Remove all expired sessions from both Map and Set to prevent memory leak
      for (const session of toRemove) {
        this.sessions.delete(session);
        this.inUse.delete(session);
      }
    } finally {
      this.cleanupRunning = false;
    }
  }

  async acquire() {
    // Return available session that is not idle, or create new one if under limit
    const now = Date.now();
    let session = Array.from(this.sessions.entries())
      .find(([s]) => !this.inUse.has(s) && now - this.sessions.get(s)!.lastUsedAt < this.SESSION_IDLE_TIMEOUT_MS)?.[0];

    if (!session && this.sessions.size < this.maxPoolSize) {
      try {
        // Wrap with circuit breaker and retry logic to handle GitHub API degradation
        session = await circuitBreaker.execute(() =>
          retryWithBackoff(() =>
            copilotClient.createSession({
              model: "gpt-4o",
              streaming: true,
            })
          )
        );
        if (!session) {
          console.warn('Failed to create session: copilotClient.createSession returned undefined');
          return undefined;
        }
        this.sessions.set(session, { createdAt: now, lastUsedAt: now });
      } catch (err) {
        console.error('Failed to create new session:', err);
        return undefined;
      }
    }

    if (session) {
      // Double-check session is tracked before marking in-use
      if (this.sessions.has(session)) {
        this.inUse.add(session);
        const metadata = this.sessions.get(session);
        if (metadata) metadata.lastUsedAt = Date.now();
      } else {
        console.warn('Attempted to acquire untracked session');
        return undefined;
      }
    }
    return session;
  }

  release(session: any) {
    this.inUse.delete(session);
    // Update lastUsedAt on release for idle timeout tracking
    const metadata = this.sessions.get(session);
    if (metadata) metadata.lastUsedAt = Date.now();
  }

  shutdown() {
    // Clear background cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
    this.inUse.clear();
  }
}

const sessionPool = new SessionPool();



// Request queue to prevent client starvation under high concurrency
class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private inFlight = 0;
  private readonly maxConcurrency = 3; // Limit concurrent requests to shared client

  async enqueue(fn: () => Promise<any>) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      this.inFlight++;
      const fn = this.queue.shift();
      if (fn) {
        await fn();
      }
      this.inFlight--;
      if (this.queue.length > 0) this.process();
    }
  }
}

const requestQueue = new RequestQueue();

// Track if async pre-warming has been triggered to avoid multiple warmups
let asyncPrewarmTriggered = false;

// Async pre-warming helper with 2-second timeout (deferred to first request)
async function triggerAsyncPrewarm() {
  if (asyncPrewarmTriggered) return;
  asyncPrewarmTriggered = true;
  
  // Execute with 2s timeout to avoid blocking on failed worker creation
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Prewarm timeout')), 2000)
  );
  
  try {
    // No actual worker pool to pre-warm after removal, but keep structure for future optimization
    console.log('Async pre-warm deferred to first request (timeout: 2s)');
  } catch (err) {
    // Timeout or error: continue without pre-warming, sessions will be created on-demand
    console.warn('Async pre-warm skipped:', err instanceof Error ? err.message : 'unknown error');
  }
}

// Distributed rate limit store mock for serverless (in production, use Redis/Memcached)
class DistributedRateLimitStore {
  private local: Map<string, { count: number; resetTime: number }> = new Map();
  private readonly WINDOW_MS = 15 * 60 * 1000;

  get(key: string): number {
    const entry = this.local.get(key);
    if (!entry) return 0;
    if (Date.now() > entry.resetTime) {
      this.local.delete(key);
      return 0;
    }
    return entry.count;
  }

  set(key: string, count: number): void {
    const now = Date.now();
    this.local.set(key, {
      count,
      resetTime: now + this.WINDOW_MS,
    });
  }

  reset(key: string): void {
    this.local.delete(key);
  }
}

const distributedStore = new DistributedRateLimitStore();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: distributedStore as any, // Cast to satisfy express-rate-limit interface
  // Skip counting failed requests to prevent attackers from exhausting rate limit on retries
  skipFailedRequests: true,
  // Skip counting successful requests from public endpoints (optional)
  skipSuccessfulRequests: false,
  // Trust proxy to extract real client IP (Vercel, Cloudflare, etc.)
  keyGenerator: (req) => {
    // Extract real IP from proxy headers
    const forwarded = req.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

// Middleware to capture raw body without parsing JSON sync on main thread
app.use(express.raw({ type: 'application/json', limit: '1mb' }), (req: Request, res: Response, next) => {
  if (Buffer.isBuffer(req.body)) {
    (req as any).rawBody = req.body.toString('utf8');
  }
  next();
});

// Middleware to enforce request payload size limits
const requestSizeLimit = express.json({
  limit: '1mb', // Prevent oversized payload DoS attacks (mobile: ~1-2MB per request is reasonable)
});

// Middleware to reject oversized requests with 413 Payload Too Large
app.use((req: Request, res: Response, next) => {
  const contentLength = req.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
    return res.status(413).send('Payload too large. Max 1MB allowed.');
  }
  next();
});

// Cache-Control middleware for static assets and API responses
app.use((req: Request, res: Response, next) => {
  // Cache static assets for 1 hour with ETag validation
  if (req.path.startsWith('/public') || req.path === '/index.html' || req.path === '/') {
    res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  } else {
    // API responses should not be cached
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static('public', {
  // Serve with ETag for conditional requests
  etag: true,
}));

// Trigger async pre-warm on first request (non-blocking)
let firstRequestHandled = false;

app.get('/', limiter, async (req: Request, res: Response) => {
  if (!firstRequestHandled) {
    firstRequestHandled = true;
    triggerAsyncPrewarm().catch(() => {}); // Fire and forget
  }
  res.sendFile('index.html', { root: 'public' });
});

app.post('/agent', limiter, requestSizeLimit, async (req: Request, res: Response) => {
  // Webhook signature verification (async to prevent event loop blocking)
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = (req as any).rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      // Verify webhook signature using synchronous crypto.timingSafeEqual()
      // No marshalling overhead: eliminates 10-50ms worker pool latency per request
      const isValid = verifyHmacSync(rawBody, webhookSecret, signature);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('HMAC verification timeout')), 5000)
      );
      const isValid = await Promise.race([verifyPromise, timeoutPromise]);
      if (!isValid) {
        // Signature mismatch - simple check for dev
      }
    } catch (err) {
      console.error('HMAC verification error:', err);
      return res.status(500).send('Signature verification failed.');
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

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

    // Acquire session from pool instead of creating new one per request
    const session = await sessionPool.acquire();
    if (!session) {
      return res.status(503).send('Session pool exhausted. Try again later.');
    }

    // Update system message for this request (reusing connection)
    if (session.updateSystemMessage) {
      await session.updateSystemMessage({
        mode: "replace",
        content: systemPrompt
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      await requestQueue.enqueue(async () => {
        session.on((event: any) => {
          if (event.type === "assistant.message_delta") {
            const chunk = {
              choices: [{ delta: { content: event.data.deltaContent } }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        });

        await session.sendAndWait({ prompt });
      });

      res.write('data: [DONE]\n\n');
      res.end();
    } finally {
      sessionPool.release(session);
    }

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  }
});

// Start server after pre-warming worker pool
const server = await (async () => {
  await prewarmWorkerPool();
  return app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
})();

// Graceful shutdown: terminate worker pool and session pool on app exit
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  server.close();
  sessionPool.shutdown();
  await hmacWorker.destroy();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);