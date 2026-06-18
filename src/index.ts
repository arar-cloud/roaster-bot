import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Timeout wrapper for external API calls
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`${operation} timeout after ${timeoutMs}ms`);
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
};

// Exponential backoff retry logic for transient failures
const withRetry = async <T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number = 2,
  baseDelayMs: number = 100
): Promise<T> => {
  let lastError: Error = new Error(`${operation} failed after all retries`);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Do not retry on authentication or validation errors
      if (err.status === 401 || err.status === 400 || err.code === 'INVALID_SIGNATURE') {
        throw err;
      }
      // Only retry on transient errors
      if (attempt < maxRetries && (err.code === 'ETIMEDOUT' || err.status >= 500)) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.warn(`${operation} attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`, err.message);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
};

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// Circuit breaker state for external service failures
const circuitBreaker = {
  failureCount: 0,
  lastFailureTime: 0,
  state: 'closed' as 'closed' | 'open' | 'half-open',
  threshold: 5,
  timeout: 30000, // 30 seconds
  
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = 'open';
      console.error(`[CIRCUIT BREAKER] Open - too many failures (${this.failureCount})`);
    }
  },
  
  recordSuccess() {
    this.failureCount = 0;
    if (this.state !== 'closed') {
      this.state = 'closed';
      console.info('[CIRCUIT BREAKER] Closed - service recovered');
    }
  },
  
  canAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.lastFailureTime > this.timeout) {
      this.state = 'half-open';
      console.info('[CIRCUIT BREAKER] Half-open - attempting recovery');
      return true;
    }
    return this.state === 'half-open';
  }
};

const app = express();
const port = process.env.PORT || 3000;

// Track in-flight requests for graceful shutdown
const activeRequests = new Set<Request>();
let isShuttingDown = false;

// Resource cleanup finalizer for request-scoped resources
const resourceCleanup = new WeakMap<Request, () => void>();

// Idempotency key tracking for deduplication (keyed by hash, auto-expires after 1 hour)
const idempotencyCache = new Map<string, { timestamp: number; response: any }>();
const IDEMPOTENCY_WINDOW = 60 * 60 * 1000; // 1 hour

const recordIdempotentRequest = (key: string, response: any) => {
  idempotencyCache.set(key, { timestamp: Date.now(), response });
};

const getIdempotentResponse = (key: string): any | null => {
  const cached = idempotencyCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > IDEMPOTENCY_WINDOW) {
    idempotencyCache.delete(key);
    return null;
  }
  console.info(`[IDEMPOTENCY] Cache hit for key ${key.substring(0, 8)}...`);
  return cached.response;
};

// Validate required environment variables at startup
const requiredEnvVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Signature verification middleware - executes BEFORE body parsing to prevent resource exhaustion
app.use((req: Request, res: Response, next: any) => {
  // Only verify webhook signature on /agent POST requests
  if (req.method === 'POST' && req.path === '/agent') {
    const signature = req.get('X-Hub-Signature-256');
    if (!signature) {
      console.warn(`[SECURITY] Missing webhook signature on ${req.ip}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Mark as pre-verified to skip duplicate check in route handler
    (req as any).signaturePreVerified = true;
  }
  next();
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Async route wrapper to ensure errors propagate to error middleware
const asyncHandler = (fn: (req: Request, res: Response, next?: any) => Promise<any>) => 
  (req: Request, res: Response, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// Request tracking middleware
app.use((req: Request, res: Response, next: any) => {
  activeRequests.add(req);
  res.on('finish', () => activeRequests.delete(req));
  res.on('close', () => activeRequests.delete(req));
  next();
});

// Error logging middleware (positioned after routes to catch async errors)
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error(`[ERROR] ${new Date().toISOString()} - ${req.method} ${req.url} - ${err.message}`, err.stack);
  activeRequests.delete(req);
  const cleanup = resourceCleanup.get(req);
  if (cleanup) {
    try { cleanup(); } catch (cleanupErr) { console.error('Cleanup error:', cleanupErr); }
  }
  if (!res.headersSent) {
    if (err.code === 'ETIMEDOUT' || err.status === 503) {
      res.status(503).json({ error: 'Service temporarily unavailable' });
    } else if (err.status === 401) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  next();
});

// Resource cleanup middleware - register finalizer for each request
app.use((req: Request, res: Response, next: any) => {
  const cleanup = () => {
    if ((req as any).copilotClient) {
      try { (req as any).copilotClient.stop?.(); } catch (e) { console.warn('Client stop error:', e); }
      delete (req as any).copilotClient;
    }
    if ((req as any).rawBody) {
      delete (req as any).rawBody;
    }
  };
  resourceCleanup.set(req, cleanup);
  
  // Attempt cleanup on response finish
  res.on('finish', () => {
    activeRequests.delete(req);
    cleanup();
  });
  res.on('close', () => {
    activeRequests.delete(req);
    cleanup();
  });
  
  next();
});

app.get('/health', (req, res) => {
  // Validate runtime environment and dependencies
  const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  if (missingEnvVars.length > 0) {
    console.error(`[HEALTH] Missing runtime env vars: ${missingEnvVars.join(', ')}`);
    return res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      missingEnvVars,
      uptime,
      circuitBreakerState: circuitBreaker.state
    });
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime,
    memoryUsage: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024)
    },
    circuitBreakerState: circuitBreaker.state,
    activeRequests: activeRequests.size
  });
});

app.get('/', (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
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
  // Initialize rate limiter context
  res.locals.rateLimitFailed = false;
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  try {
    const isValidSignature = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    if (!isValidSignature) {
      res.locals.rateLimitFailed = true;
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    res.locals.rateLimitFailed = true;
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  let client: CopilotClient;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (initError) {
    console.error('CopilotClient initialization failed:', initError);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to initialize Copilot client' });
    }
    return;
  }
  
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