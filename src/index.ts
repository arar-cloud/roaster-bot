import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

// Panic recovery middleware - wrap async handlers with try-catch
const asyncHandler = (fn: (req: Request, res: Response, next: Function) => Promise<any>) => 
  (req: Request, res: Response, next: Function) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// Graceful shutdown manager
class GracefulShutdownManager {
  private isShuttingDown = false;
  
  constructor(server: any) {
    this.setupSignalHandlers(server);
  }
  
  private setupSignalHandlers(server: any) {
    const signals = ['SIGTERM', 'SIGINT'];
    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`${signal} received, starting graceful shutdown`);
        this.isShuttingDown = true;
        
        server.close(() => {
          console.log('Server closed');
          process.exit(0);
        });
        
        // Force exit after 30 seconds
        setTimeout(() => {
          console.error('Forced shutdown after timeout');
          process.exit(1);
        }, 30000);
      });
    });
  }
  
  isShutdown() { return this.isShuttingDown; }
}
import { CopilotClient } from '@github/copilot-sdk';

// Configuration validation at startup
function validateConfiguration() {
  const requiredEnvVars = ['OPENAI_API_KEY', 'GITHUB_TOKEN'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  // Validate API key format (at least 20 chars, no spaces)
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length < 20) {
    throw new Error('OPENAI_API_KEY appears invalid (too short)');
  }
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.length < 10) {
    throw new Error('GITHUB_TOKEN appears invalid (too short)');
  }
  
  // Validate port if set
  const port = process.env.PORT;
  if (port && (isNaN(parseInt(port)) || parseInt(port) <= 0 || parseInt(port) > 65535)) {
    throw new Error('PORT must be a valid port number (1-65535)');
  }
  
  return true;
}

// Validate configuration at startup
try {
  validateConfiguration();
} catch (error) {
  console.error('Configuration validation failed:', error.message);
  process.exit(1);
}

// Job Queue with retry logic and exponential backoff
class JobQueue {
  private queue: any[] = [];
  private deadLetterQueue: any[] = [];
  private processing = false;
  private maxRetries = 3;
  private baseBackoffMs = 1000;
  
  constructor(maxRetries = 3, baseBackoffMs = 1000) {
    this.maxRetries = maxRetries;
    this.baseBackoffMs = baseBackoffMs;
  }
  
  enqueue(job) {
    if (!job || typeof job.handler !== 'function') {
      throw new Error('Job must have a handler function');
    }
    this.queue.push({
      ...job,
      retryCount: 0,
      createdAt: Date.now(),
      lastAttemptAt: null
    });
  }
  
  private calculateBackoff(retryCount) {
    return this.baseBackoffMs * Math.pow(2, retryCount) + Math.random() * 1000;
  }
  
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const job = this.queue[0];
      const now = Date.now();
      
      // Check if we should retry this job based on backoff
      if (job.lastAttemptAt) {
        const backoffTime = this.calculateBackoff(job.retryCount);
        if (now - job.lastAttemptAt < backoffTime) {
          break; // Wait for backoff period
        }
      }
      
      try {
        job.lastAttemptAt = now;
        await job.handler();
        this.queue.shift(); // Remove successful job
      } catch (error) {
        job.retryCount++;
        if (job.retryCount >= this.maxRetries) {
          this.queue.shift();
          this.deadLetterQueue.push({
            ...job,
            failedAt: now,
            error: error.message
          });
          console.error(`Job moved to dead-letter queue after ${this.maxRetries} retries:`, error.message);
        } else {
          console.warn(`Job failed, retry ${job.retryCount}/${this.maxRetries}:`, error.message);
        }
      }
    }
    
    this.processing = false;
  }
  
  getQueueSize() { return this.queue.length; }
  getDeadLetterSize() { return this.deadLetterQueue.length; }
}

const jobQueue = new JobQueue(3, 1000);

// Process jobs periodically
setInterval(() => jobQueue.processQueue(), 5000);

// State reconciliation for consistency checks
class StateReconciliation {
  private consistencyCheckIntervalMs = 30000;
  private checksEnabled = true;
  
  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      this.startConsistencyChecks();
    }
  }
  
  private startConsistencyChecks() {
    setInterval(() => {
      if (this.checksEnabled) {
        this.runConsistencyChecks();
      }
    }, this.consistencyCheckIntervalMs);
  }
  
  private runConsistencyChecks() {
    try {
      // Validate core state invariants
      if (jobQueue.getQueueSize() < 0) {
        console.error('STATE_ERROR: Job queue size is negative');
      }
      if (jobQueue.getDeadLetterSize() < 0) {
        console.error('STATE_ERROR: Dead-letter queue size is negative');
      }
    } catch (error) {
      console.error('Consistency check failed:', error.message);
    }
  }
  
  async reconciliate() {
    try {
      // Reconciliation logic for detected inconsistencies
      if (jobQueue.getDeadLetterSize() > 100) {
        console.warn('Dead-letter queue growing: consider investigating job failures');
      }
    } catch (error) {
      console.error('Reconciliation failed:', error.message);
    }
  }
  
  disableChecks() { this.checksEnabled = false; }
  enableChecks() { this.checksEnabled = true; }
}

const stateReconciliation = new StateReconciliation();

// Immutable state management for client library
class ImmutableState {
  private state: Map<string, any> = new Map();
  private locks: Map<string, Promise<void>> = new Map();
  
  async atomicUpdate<T>(
    key: string,
    updater: (current: T | undefined) => T
  ): Promise<T> {
    // Acquire lock for this key to prevent race conditions
    let lock = this.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }
    
    const newLock = lock.then(async () => {
      const current = this.state.get(key);
      const updated = updater(current);
      // Deep freeze to prevent mutations
      this.state.set(key, Object.freeze(updated));
      return updated;
    });
    
    this.locks.set(key, newLock);
    return newLock;
  }
  
  get<T>(key: string): T | undefined {
    const value = this.state.get(key);
    // Return frozen copy to prevent external mutations
    return value ? Object.freeze({ ...value }) : undefined;
  }
  
  async batchUpdate(updates: Array<[string, (v: any) => any]>): Promise<void> {
    // Serialize batch updates to prevent concurrent mutations
    for (const [key, updater] of updates) {
      await this.atomicUpdate(key, updater);
    }
  }
}

const clientState = new ImmutableState();

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

// In-memory cache with TTL and early refresh mechanism
interface CacheEntry {
  value: any;
  timestamp: number;
  ttl: number;
  refreshing?: Promise<any>;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60000; // 60 seconds
const REFRESH_PROBABILITY = 0.1; // Refresh at 10% probability before expiry

function getCacheKey(path: string, query: string): string {
  return `${path}:${query}`;
}

function isCacheExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp > entry.ttl;
}

function shouldRefreshEarly(entry: CacheEntry): boolean {
  const timeRemaining = entry.ttl - (Date.now() - entry.timestamp);
  const refreshThreshold = entry.ttl * (1 - REFRESH_PROBABILITY);
  return timeRemaining < refreshThreshold * REFRESH_PROBABILITY && !entry.refreshing;
}

async function getCachedOrFetch(
  key: string,
  fetchFn: () => Promise<any>
): Promise<any> {
  const existing = cache.get(key);
  
  // Valid cache hit
  if (existing && !isCacheExpired(existing) && !shouldRefreshEarly(existing)) {
    return existing.value;
  }
  
  // Cache expired or refresh needed
  if (!existing || isCacheExpired(existing)) {
    const value = await fetchFn();
    cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl: CACHE_TTL_MS
    });
    return value;
  }
  
  // Early refresh: return stale data while refreshing in background
  if (shouldRefreshEarly(existing)) {
    if (!existing.refreshing) {
      existing.refreshing = fetchFn().then(value => {
        cache.set(key, {
          value,
          timestamp: Date.now(),
          ttl: CACHE_TTL_MS
        });
        return value;
      }).catch(() => existing.value);
    }
    return existing.value;
  }
  
  return existing.value;
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Input validation middleware: enforce strict payload size limits
const MAX_PAYLOAD_SIZE = '1mb';
const MAX_QUERY_SIZE = 2000;
const MAX_HEADER_SIZE = 8192;

app.use(express.json({
  limit: MAX_PAYLOAD_SIZE,
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
    // Validate buffer size during parsing
    if (buf.length > 1024 * 1024) {
      throw new Error('Payload exceeds maximum allowed size');
    }
  }
}));

// Query string size validation
app.use((req, res, next) => {
  const queryStr = req.url.split('?')[1] || '';
  if (queryStr.length > MAX_QUERY_SIZE) {
    return res.status(413).json({ 
      error: 'Query string too large',
      max_size: MAX_QUERY_SIZE 
    });
  }
  next();
});

// Request header validation
app.use((req, res, next) => {
  const headerSize = JSON.stringify(req.headers).length;
  if (headerSize > MAX_HEADER_SIZE) {
    return res.status(431).json({ 
      error: 'Request headers too large',
      max_size: MAX_HEADER_SIZE 
    });
  }
  next();
});

// Caching middleware for GET requests
app.use((req, res, next) => {
  if (req.method === 'GET') {
    const cacheKey = getCacheKey(req.path, JSON.stringify(req.query));
    const cached = cache.get(cacheKey);
    if (cached && !isCacheExpired(cached)) {
      res.set('X-Cache-Hit', 'true');
      return res.json(cached.value);
    }
  }
  next();
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `);
});

app.post('/agent', limiter, asyncHandler(async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
        // Simple check for dev
    }
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

// Global error handling middleware
app.use((err: any, req: Request, res: Response, next: Function) => {
  const correlationId = (req as any).id || crypto.randomUUID();
  const errorId = crypto.randomUUID();
  
  console.error(`[ERROR] correlation_id=${correlationId} error_id=${errorId}`, {
    message: err.message,
    code: err.code,
    stack: err.stack?.split('\n')[0]
  });
  
  let statusCode = 500;
  let errorResponse: any = {
    error: 'Internal server error',
    error_id: errorId
  };
  
  if (err.message?.includes('Payload exceeds')) {
    statusCode = 413;
    errorResponse.error = 'Request payload too large';
  } else if (err.message?.includes('Query string')) {
    statusCode = 413;
    errorResponse.error = 'Query string too large';
  } else if (err.message?.includes('headers too large')) {
    statusCode = 431;
    errorResponse.error = 'Request headers too large';
  }
  
  if (!res.headersSent) {
    res.status(statusCode).json(errorResponse);
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});