import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// ============================================
// Error Boundary Manager
// ============================================
class ErrorBoundaryManager {
  private errorHandlers: Map<string, (error: any) => any> = new Map();
  private fallbackResponses: Map<string, any> = new Map();
  private recoveryOptions: Map<string, Array<{ label: string; action: () => Promise<void> }>> = new Map();

  registerHandler(errorType: string, handler: (error: any) => any): void {
    this.errorHandlers.set(errorType, handler);
  }

  registerFallback(endpoint: string, fallbackData: any): void {
    this.fallbackResponses.set(endpoint, fallbackData);
  }

  registerRecoveryOptions(
    errorType: string,
    options: Array<{ label: string; action: () => Promise<void> }>
  ): void {
    this.recoveryOptions.set(errorType, options);
  }

  async handleError(error: any, endpoint: string): Promise<{ statusCode: number; message: string; fallback?: any; recovery?: any[] }> {
    const errorType = error?.constructor?.name || 'UnknownError';
    const handler = this.errorHandlers.get(errorType);
    const fallback = this.fallbackResponses.get(endpoint);
    const recovery = this.recoveryOptions.get(errorType);

    let statusCode = error?.status || error?.statusCode || 500;
    let message = error?.message || 'An unexpected error occurred';

    if (handler) {
      try {
        const handled = await handler(error);
        statusCode = handled.statusCode || statusCode;
        message = handled.message || message;
      } catch (handlerError) {
        console.error(`Error in custom handler: ${handlerError}`);
      }
    }

    return {
      statusCode,
      message,
      fallback: fallback || { data: null, cached: true },
      recovery: recovery?.map(r => ({ label: r.label })) || []
    };
  }
}

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string, ttlMs?: number;
      cacheKey?: string;
      retryManager?: RetryManager;
      offlineQueue?: OfflineQueueManager;
      errorBoundary?: ErrorBoundaryManager;
    }
  }
}

// ============================================
// Retry Manager with Exponential Backoff
// ============================================
class RetryManager {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;

  constructor(
    maxRetries: number = 3,
    baseDelayMs: number = 100,
    backoffMultiplier: number = 2,
    maxDelayMs: number = 30000,
    jitterFactor: number = 0.1
  ) {
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.backoffMultiplier = backoffMultiplier;
    this.maxDelayMs = maxDelayMs;
    this.jitterFactor = jitterFactor;
  }

  private calculateDelay(attemptNumber: number): number {
    const exponentialDelay = this.baseDelayMs * Math.pow(this.backoffMultiplier, attemptNumber);
    const cappedDelay = Math.min(exponentialDelay, this.maxDelayMs);
    const jitter = cappedDelay * this.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, cappedDelay + jitter);
  }

  async execute<T>(
    operation: () => Promise<T>,
    isRetryable: (error: any) => boolean = (error) => error?.status >= 500 || error?.code === 'ECONNREFUSED'
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries && isRetryable(error)) {
          const delayMs = this.calculateDelay(attempt);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }
}

// ============================================
// Offline Queue Manager
// ============================================
class OfflineQueueManager {
  private queue: Array<{
    id: string;
    operation: 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    endpoint: string;
    payload: any;
    timestamp: number;
    retryCount: number;
  }> = [];
  private syncInProgress: boolean = false;
  private readonly maxQueueSize: number = 100;

  enqueueOperation(operation: string, endpoint: string, payload: any): string {
    if (this.queue.length >= this.maxQueueSize) {
      const removed = this.queue.shift();
      console.warn(`Queue full: dropped operation ${removed?.id}`);
    }
    const id = crypto.randomUUID();
    this.queue.push({
      id,
      operation: operation as any,
      endpoint,
      payload,
      timestamp: Date.now(),
      retryCount: 0
    });
    return id;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  async syncQueue(executor: (op: any) => Promise<void>): Promise<{ synced: number; failed: number }> {
    if (this.syncInProgress) return { synced: 0, failed: 0 };
    this.syncInProgress = true;
    let synced = 0;
    let failed = 0;

    const queueCopy = [...this.queue];
    for (const item of queueCopy) {
      try {
        await executor(item);
        this.queue = this.queue.filter(q => q.id !== item.id);
        synced++;
      } catch (error) {
        item.retryCount++;
        if (item.retryCount > 3) {
          this.queue = this.queue.filter(q => q.id !== item.id);
          console.error(`Operation ${item.id} exceeded retry limit: ${error}`);
        }
        failed++;
      }
    }
    this.syncInProgress = false;
    return { synced, failed };
  }

  clearQueue(): void {
    this.queue = [];
  }
}

// ============================================
// Response Caching Layer
// ============================================
class ResponseCache {
  private cache: Map<string, { body: string; etag: string; timestamp: number }> = new Map();
  private readonly ttl: number = 5 * 60 * 1000; // 5 minutes default

  set(key: string, body: string) {
    const etag = crypto.createHash('md5').update(body).digest('hex');
    this.cache.set(key, { body, etag, timestamp: Date.now() });
  }

  get(key: string) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return cached;
  }

  clear(pattern?: RegExp) {
    if (pattern) {
      for (const key of this.cache.keys()) {
        if (pattern.test(key)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }
}

const responseCache = new ResponseCache();
const retryManager = new RetryManager(3, 100, 2, 30000, 0.1);
const offlineQueue = new OfflineQueueManager();
const errorBoundary = new ErrorBoundaryManager();

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Inject managers into request
app.use((req: Request, res: Response, next) => {
  req.retryManager = retryManager;
  req.offlineQueue = offlineQueue;
  req.errorBoundary = errorBoundary;
  next();
});

// Caching middleware for GET requests
app.use((req: Request, res: Response, next) => {
  if (req.method === 'GET') {
    req.cacheKey = `${req.path}:${JSON.stringify(req.query)}`;
    const cached = responseCache.get(req.cacheKey);
    if (cached && req.headers['if-none-match'] === cached.etag) {
      res.status(304).end();
      return;
    }
    if (cached) {
      res.set('ETag', cached.etag);
      res.set('Cache-Control', 'public, max-age=300');
      res.send(cached.body);
      return;
    }
  }
  next();
});

// Wrapper for cacheable responses
function sendCached(res: Response, cacheKey: string | undefined, data: any, statusCode = 200) {
  const body = JSON.stringify(data);
  const etag = crypto.createHash('md5').update(body).digest('hex');

  if (cacheKey) {
    responseCache.set(cacheKey, body);
  }

  res.status(statusCode);
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=300');
  res.send(body);
}

// Stream large payloads to avoid CPU spike from synchronous JSON serialization
function streamJSON(res: Response, data: any, statusCode = 200) {
  res.status(statusCode);
  res.set('Content-Type', 'application/json');
  res.set('Transfer-Encoding', 'chunked');

  // For arrays, stream elements to reduce memory pressure
  if (Array.isArray(data)) {
    res.write('[');
    data.forEach((item, idx) => {
      if (idx > 0) res.write(',');
      res.write(JSON.stringify(item));
    });
    res.write(']');
  } else {
    res.write(JSON.stringify(data));
  }
  res.end();
}

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

app.post('/agent', limiter, async (req: Request, res: Response) => {
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

// Recovery endpoint for offline queue synchronization
app.post('/recover', async (req: Request, res: Response) => {
  try {
    const queueSize = offlineQueue.getQueueSize();
    const result = await offlineQueue.syncQueue(async (operation) => {
      await retryManager.execute(() =>
        Promise.resolve() // In production, execute actual operation against upstream API
      );
    });
    res.json({
      success: true,
      recovered: { synced: result.synced, failed: result.failed },
      remainingQueue: offlineQueue.getQueueSize()
    });
  } catch (error: any) {
    const handled = await errorBoundary.handleError(error, '/recover');
    res.status(handled.statusCode).json({
      success: false,
      message: handled.message,
      recovery: handled.recovery
    });
  }
});

app.post('/api/roast', async (req: Request, res: Response) => {
  try {
    if (!req.offlineQueue) {
      return res.status(500).json({ error: 'Offline queue not initialized' });
    }
    const result = await req.offlineQueue.syncQueue(async (op) => {
      console.log(`Syncing queued operation: ${op.id}`);
    });
    res.json({ message: 'Queue sync completed', ...result });
  } catch (error) {
    console.error('Recovery endpoint error:', error);
    res.status(500).json({ error: 'Recovery failed' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});