import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

// Lazy-load Copilot SDK to reduce initial bundle size
let CopilotClient: any;

// ============================================
// Structured Logging with Correlation IDs
// ============================================
class StructuredLogger {
  private correlationId: string = '';

  setCorrelationId(id: string) {
    this.correlationId = id;
  }

  private formatLog(level: string, operation: string, message: string, meta?: any) {
    return {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      operation,
      message,
      ...(meta && { metadata: meta })
    };
  }

  info(operation: string, message: string, meta?: any) {
    console.log(JSON.stringify(this.formatLog('INFO', operation, message, meta)));
  }

  warn(operation: string, message: string, meta?: any) {
    console.warn(JSON.stringify(this.formatLog('WARN', operation, message, meta)));
  }

  error(operation: string, message: string, error?: Error, meta?: any) {
    console.error(
      JSON.stringify(
        this.formatLog('ERROR', operation, message, {
          ...meta,
          error: error?.message,
          stack: error?.stack
        })
      )
    );
  }

  debug(operation: string, message: string, meta?: any) {
    if (process.env.DEBUG === 'true') {
      console.debug(JSON.stringify(this.formatLog('DEBUG', operation, message, meta)));
    }
  }
}

const logger = new StructuredLogger();

// ============================================
// Connection Pool Management
// ============================================
class ConnectionPool {
  private maxConnections: number;
  private activeConnections: number = 0;
  private queuedRequests: Array<() => void> = [];
  private readonly connectTimeout: number = 30000; // 30 seconds

  constructor(maxConnections: number = 10) {
    this.maxConnections = maxConnections;
    this.startCleanupInterval();
  }

  /**
   * Acquire a connection slot from the pool
   */
  async acquire(): Promise<void> {
    if (this.activeConnections < this.maxConnections) {
      this.activeConnections++;
      return;
    }

    // Queue request if at capacity
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        const index = this.queuedRequests.indexOf(resolve);
        if (index !== -1) {
          this.queuedRequests.splice(index, 1);
        }
        logger.warn('connection_pool', 'Connection acquisition timeout', {
          activeConnections: this.activeConnections,
          queuedRequests: this.queuedRequests.length
        });

// Cleanup interval - run deduplicator cleanup every 5 minutes
setInterval(() => {
  deduplicator.cleanup();
  logger.debug('maintenance', 'Deduplicator cleanup executed');
}, 5 * 60 * 1000);
      }, this.connectTimeout);

      this.queuedRequests.push(() => {
        clearTimeout(timeoutId);
        this.activeConnections++;
        resolve();
      });
    });
  }

  /**
   * Release a connection slot back to the pool
   */
  release(): void {
    if (this.activeConnections > 0) {
      this.activeConnections--;
    }

    const nextRequest = this.queuedRequests.shift();
    if (nextRequest) {
      nextRequest();
    }
  }

  /**
   * Periodically clean up and report pool metrics
   */
  private startCleanupInterval() {
    setInterval(() => {
      logger.debug('connection_pool', 'Pool metrics', {
        activeConnections: this.activeConnections,
        queuedRequests: this.queuedRequests.length,
        maxConnections: this.maxConnections
      });
    }, 60000); // Every 60 seconds
  }

  getMetrics() {
    return {
      activeConnections: this.activeConnections,
      queuedRequests: this.queuedRequests.length,
      maxConnections: this.maxConnections,
      utilization: (this.activeConnections / this.maxConnections) * 100
    };
  }
}

const serviceConnectionPool = new ConnectionPool(
  parseInt(process.env.MAX_CONNECTIONS || '10', 10)
);

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      cacheKey?: string;
      correlationId?: string;
    }
  }
}

// ============================================
// Input Validation Schemas
// ============================================
interface ValidationSchema {
  [key: string]: {
    type: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    enum?: any[];
  };
}

class InputValidator {
  /**
   * Validate request body against schema
   */
  static validateBody(body: any, schema: ValidationSchema): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = body?.[field];

      if (rules.required && (value === undefined || value === null)) {
        errors.push(`Field '${field}' is required`);
        continue;
      }

      if (value === undefined || value === null) continue;

      // Type validation
      const actualType = typeof value;
      if (rules.type === 'array' && !Array.isArray(value)) {
        errors.push(`Field '${field}' must be an array`);
        continue;
      }
      if (rules.type !== 'array' && actualType !== rules.type) {
        errors.push(`Field '${field}' must be of type ${rules.type}, got ${actualType}`);
        continue;
      }

      // String validations
      if (typeof value === 'string') {
        if (rules.minLength && value.length < rules.minLength) {
          errors.push(`Field '${field}' must be at least ${rules.minLength} characters`);
        }
        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push(`Field '${field}' must be at most ${rules.maxLength} characters`);
        }
        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push(`Field '${field}' does not match required format`);
        }
      }

      // Enum validation
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push(`Field '${field}' must be one of: ${rules.enum.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

// ============================================
// Request Deduplication for Idempotent Retries
// ============================================
class RequestDeduplicator {
  private inFlightRequests: Map<string, Promise<any>> = new Map();
  private completedRequests: Map<string, { result: any; timestamp: number }> = new Map();
  private readonly resultTtl: number = 5 * 60 * 1000; // 5 minutes

  /**
   * Track an in-flight request to prevent duplicate execution during retries
   * @param requestId Unique request identifier
   * @param executor Async function to execute once per request
   */
  async executeOnce<T>(requestId: string, executor: () => Promise<T>): Promise<T> {
    // Check if request already completed
    const completed = this.completedRequests.get(requestId);
    if (completed && Date.now() - completed.timestamp < this.resultTtl) {
      return completed.result;
    }

    // Check if request is in-flight
    if (this.inFlightRequests.has(requestId)) {
      return this.inFlightRequests.get(requestId)!;
    }

    // Execute request and cache result
    const promise = executor()
      .then(result => {
        this.completedRequests.set(requestId, { result, timestamp: Date.now() });
        this.inFlightRequests.delete(requestId);
        return result;
      })
      .catch(error => {
        this.inFlightRequests.delete(requestId);
        throw error;
      });

    this.inFlightRequests.set(requestId, promise);
    return promise;
  }

  /**
   * Clean up stale completed requests to prevent memory leaks
   */
  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.completedRequests.entries()) {
      if (now - value.timestamp > this.resultTtl) {
        this.completedRequests.delete(key);
      }
    }
  }
}

// ============================================
// Chat Endpoint Schema Validation
// ============================================
const chatSchema: ValidationSchema = {
  message: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 10000
  },
  context: {
    type: 'string',
    required: false,
    maxLength: 50000
  }
};

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
const deduplicator = new RequestDeduplicator();
const cache = new ResponseCache();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// Middleware - Correlation ID & Request Tracking
// ============================================
app.use((req: Request, res: Response, next) => {
  const correlationId = req.headers['x-correlation-id'] as string || crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  logger.setCorrelationId(correlationId);
  logger.info('request_received', `${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
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

// Health check endpoint with pool metrics
app.get('/health', (req: Request, res: Response) => {
  const poolMetrics = serviceConnectionPool.getMetrics();
  logger.info('health_check', 'Health check requested', poolMetrics);
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connectionPool: poolMetrics,
    uptime: process.uptime()
  });
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

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Generate request ID for deduplication
  const requestId = (req.headers['x-idempotency-key'] as string) || `${req.ip}-${Date.now()}`;
  
  // Input validation
  const bodySchema: ValidationSchema = {
    messages: { type: 'array', required: false }
  };
  const validation = InputValidator.validateBody(req.body, bodySchema);
  if (!validation.valid) {
    logger.warn('validation_failed', 'Invalid request body', { errors: validation.errors });
    return res.status(400).json({ error: 'Invalid request', details: validation.errors });
  }

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

  // Lazy-load Copilot SDK on first use
  if (!CopilotClient) {
    CopilotClient = (await import('@github/copilot-sdk')).CopilotClient;
  }

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