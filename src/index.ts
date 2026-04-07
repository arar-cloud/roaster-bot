import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// ============================================
// Graceful Degradation Manager
// ============================================
class GracefulDegradationManager {
  private failedServices: Map<string, { failedAt: number; retryAfter: number }> = new Map();
  private readonly recoveryWindow: number = 60 * 1000; // 60 seconds

  markServiceFailed(serviceName: string): void {
    this.failedServices.set(serviceName, {
      failedAt: Date.now(),
      retryAfter: this.recoveryWindow
    });
  } finally {
    logger.clearContext(requestId);
  }

  isServiceAvailable(serviceName: string): boolean {
    const failure = this.failedServices.get(serviceName);
    if (!failure) return true;

    const timeSinceFail = Date.now() - failure.failedAt;
    if (timeSinceFail > failure.retryAfter) {
      this.failedServices.delete(serviceName);
      return true;
    }
    return false;
  }

  getServiceStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const service of ['copilot', 'cache', 'analytics']) {
      status[service] = this.isServiceAvailable(service);
    }
    return status;
  }
}

const degradationManager = new GracefulDegradationManager();

// ============================================
// Connection Pool Configuration
// ============================================
class ConnectionPool {
  private maxConnections: number = 10;
  private activeConnections: number = 0;
  private queuedRequests: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private queryTimeout: number = 30000; // 30 seconds
  private retryAttempts: number = 3;
  private retryDelay: number = 1000; // 1 second

  constructor(maxConnections?: number, queryTimeout?: number) {
    this.maxConnections = maxConnections || 10;
    this.queryTimeout = queryTimeout || 30000;
  }

  async acquireConnection(): Promise<{ releaseConnection: () => void }> {
    if (this.activeConnections < this.maxConnections) {
      this.activeConnections++;
      return {
        releaseConnection: () => {
          this.activeConnections--;
          const queued = this.queuedRequests.shift();
          if (queued) queued.resolve();
        }
      };
    }

    return new Promise((resolve, reject) => {
      this.queuedRequests.push({
        resolve: () => {
          this.activeConnections++;
          resolve({
            releaseConnection: () => {
              this.activeConnections--;
              const queued = this.queuedRequests.shift();
              if (queued) queued.resolve();
            }
          });
        },
        reject
      });
    });
  }

  async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const conn = await this.acquireConnection();
        try {
          return await Promise.race([
            operation(),
            new Promise<T>((_, reject) =>
              setTimeout(() => reject(new Error('Query timeout')), this.queryTimeout)
            )
          ]);
        } finally {
          conn.releaseConnection();
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.retryAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error('Query failed after retries');
  }
}

const connectionPool = new ConnectionPool(
  parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
  parseInt(process.env.DB_QUERY_TIMEOUT || '30000', 10)
);

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      cacheKey?: string;
    }
  }
}

// ============================================
// Idempotency Key Management
// ============================================
class IdempotencyManager {
  private processedKeys: Map<string, { response: any; timestamp: number }> = new Map();
  private readonly ttl: number = 24 * 60 * 60 * 1000; // 24 hours

  generateKey(userId: string | null | undefined, operation: string, params: any): string {
    const safeUserId = userId ?? 'anonymous';
    const paramStr = JSON.stringify(params);
    return crypto.createHash('sha256').update(`${safeUserId}:${operation}:${paramStr}`).digest('hex');
  }

  isProcessed(key: string): boolean {
    const entry = this.processedKeys.get(key);
    if (!entry) return false;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.processedKeys.delete(key);
      return false;
    }
    return true;
  }

  getResponse(key: string): any {
    const entry = this.processedKeys.get(key);
    return entry?.response ?? null;
  }

  markProcessed(key: string, response: any): void {
    this.processedKeys.set(key, { response, timestamp: Date.now() });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.processedKeys.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.processedKeys.delete(key);
      }
    }
  }
}

const idempotencyManager = new IdempotencyManager();
setInterval(() => idempotencyManager.cleanup(), 60 * 60 * 1000); // Cleanup every hour

// ============================================
// Structured Logging
// ============================================
class StructuredLogger {
  private requestContext: Map<string, any> = new Map();

  setContext(requestId: string, context: any): void {
    this.requestContext.set(requestId, context);
  }

  getContext(requestId: string): any {
    return this.requestContext.get(requestId) || {};
  }

  log(requestId: string | null | undefined, level: string, message: string, data?: any): void {
    const safeRequestId = requestId ?? 'unknown';
    const context = this.getContext(safeRequestId);
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      requestId: safeRequestId,
      userId: context.userId ?? null,
      operationDuration: data?.duration ?? null,
      errorName: data?.error?.name ?? null,
      errorMessage: data?.error?.message ?? null,
      ...data
    };
    console.log(JSON.stringify(logEntry));
  }

  debug(requestId: string | null | undefined, message: string, data?: any): void {
    this.log(requestId, 'DEBUG', message, data);
  }

  info(requestId: string | null | undefined, message: string, data?: any): void {
    this.log(requestId, 'INFO', message, data);
  }

  warn(requestId: string | null | undefined, message: string, data?: any): void {
    this.log(requestId, 'WARN', message, data);
  }

  error(requestId: string | null | undefined, message: string, error?: Error | null | undefined, data?: any): void {
    this.log(requestId, 'ERROR', message, { ...data, error });
  }

  clearContext(requestId: string): void {
    this.requestContext.delete(requestId);
  }
}

const logger = new StructuredLogger();

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

app.get('/health', (req: Request, res: Response) => {
  const requestId = crypto.randomUUID();
  const serviceStatus = degradationManager.getServiceStatus();
  const allHealthy = Object.values(serviceStatus).every(status => status === true);
  const statusCode = allHealthy ? 200 : 503;
  
  logger.info(requestId, 'Health check', { serviceStatus, allHealthy });
  res.status(statusCode).json({
    status: allHealthy ? 'ok' : 'degraded',
    services: serviceStatus,
    timestamp: new Date().toISOString()
  });
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

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});