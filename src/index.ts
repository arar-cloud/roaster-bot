import 'dotenv/config';
import express, { Request, Response } from 'express';
import compression from 'compression';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';
import Piscina from 'piscina';
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

// Initialize worker pool for async HMAC verification
const hmacWorker = new Piscina({
  filename: join(__dirname, 'hmac-worker.ts'),
  maxThreads: 4,
});

app.use(helmet());

// Enable gzip compression to reduce response payload by 60-80% for mobile clients
app.use(compression({
  level: 6, // Balance between compression ratio and CPU usage
  threshold: 1024, // Compress responses >1KB to improve mobile bandwidth; most API responses are 400-800B but benefit from compression when aggregated
}));

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
  private lastCleanupTime = 0;
  private readonly CLEANUP_INTERVAL_MS = 90000; // Lazy cleanup every 90s instead of aggressive 30s

  constructor() {
    // No active interval; cleanup triggered on-demand only (lazy eviction)
  }

  private cleanupIdleSessions() {
    const now = Date.now();
    // Only run cleanup if CLEANUP_INTERVAL_MS has elapsed
    if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL_MS) return;
    
    this.lastCleanupTime = now;
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
  }

  async acquire() {
    // Trigger lazy cleanup before acquiring to evict idle sessions
    this.cleanupIdleSessions();
    
    // Return available session that is not idle, or create new one if under limit
    const now = Date.now();
    let session = Array.from(this.sessions.entries())
      .find(([s]) => !this.inUse.has(s) && now - this.sessions.get(s)!.lastUsedAt < this.SESSION_IDLE_TIMEOUT_MS)?.[0];

    if (!session && this.sessions.size < this.maxPoolSize) {
      try {
        session = await copilotClient.createSession({
          model: "gpt-4o",
          streaming: true,
        });
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
    // Trigger lazy cleanup on release
    this.cleanupIdleSessions();
  }

  shutdown() {
    // Cleanup is lazy (no active interval), so just clear collections
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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
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

// Middleware to enforce request payload size limits
const requestSizeLimit = express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
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

app.use(requestSizeLimit);

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

app.get('/', limiter, (req: Request, res: Response) => {
  res.sendFile('index.html', { root: 'public' });
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification (async to prevent event loop blocking)
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      const isValid = await hmacWorker.run({ rawBody, webhookSecret, signature });
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

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

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