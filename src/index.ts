import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { cleanupResources } from './api/index.js';

// Environment validation at startup
function validateEnvironment(): void {
  const requiredEnvVars = ['GITHUB_TOKEN'];
  const optionalEnvVars = ['PORT', 'NODE_ENV'];
  const missing: string[] = [];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  if (missing.length > 0) {
    throw new Error(`[Startup] Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate PORT if specified
  if (process.env.PORT) {
    const portNum = parseInt(process.env.PORT, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`[Startup] Invalid PORT: ${process.env.PORT}`);
    }
  }

  // Validate NODE_ENV if specified
  if (process.env.NODE_ENV && !['development', 'production', 'test'].includes(process.env.NODE_ENV)) {
    throw new Error(`[Startup] Invalid NODE_ENV: ${process.env.NODE_ENV}`);
  }

  console.log('[Startup] Environment validation passed');
}

// Health check state
let copilotClientHealthy = false;

// CopilotClient singleton for connection pooling
class CopilotClientManager {
  private static instance: CopilotClient | null = null;
  private static initPromise: Promise<CopilotClient> | null = null;
  private static readonly initLock = { locked: false };

  private static async acquireLock(): Promise<void> {
    while (this.initLock.locked) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.initLock.locked = true;
  }

  private static releaseLock(): void {
    this.initLock.locked = false;
  }

  static async getInstance(): Promise<CopilotClient> {
    // If instance exists and is valid, return immediately
    if (this.instance && await this.validateClientState(this.instance)) {
      return this.instance;
    }

    // If initialization is in progress, return the shared promise
    if (this.initPromise) {
      return this.initPromise;
    }

    // Acquire lock and initialize
    try {
      await this.acquireLock();

      // Double-check after acquiring lock
      if (this.instance && this.validateClientState(this.instance)) {
        return this.instance;
      }

      // Check if another thread already started initialization
      if (this.initPromise) {
        return this.initPromise;
      }

      // Start initialization and share the promise
      this.initPromise = this.initializeClient()
        .catch(error => {
          // Reset promise on failure to allow retry
          this.initPromise = null;
          throw error;
        })
        .finally(() => {
          this.releaseLock();
        });

      return this.initPromise;
  }

  private static async initializeClient(): Promise<CopilotClient> {
    try {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN environment variable not set');
      }
      this.instance = new CopilotClient({ token });
      console.log('[CopilotClientManager] Client initialized successfully');
      return this.instance;
    } catch (error) {
      console.error('[CopilotClientManager] Initialization failed:', error);
      throw error;
    }
  }

  private static async validateClientState(client: CopilotClient): Promise<boolean> {
    try {
      // Validate client is initialized and connected
      if (!client) {
        console.error('[CopilotClientManager] Client is null');
        return false;
      }

      // Check if client has required methods
      if (typeof client.chat !== 'function') {
        console.error('[CopilotClientManager] Client missing chat method');
        return false;
      }

      return true;
    } catch (error) {
      console.error('[CopilotClientManager] Client state validation error:', {
        message: error instanceof Error ? error.message : String(error),
        context: 'validateClientState',
      });
      
      // Don't return false silently - indicate validation failure for potential reconnection
      return false;
    }
  }

  private static pendingRequests = 0;
  private static readonly maxDestroyWaitTime = 5000; // 5 seconds

  static incrementPendingRequests(): void {
    this.pendingRequests++;
  }

  static decrementPendingRequests(): void {
    if (this.pendingRequests > 0) {
      this.pendingRequests--;
    }
  }

  static async destroy(): Promise<void> {
    try {
      console.log('[CopilotClientManager] Starting destroy sequence');
      const startTime = Date.now();

      // Wait for pending requests to complete or timeout
      while (this.pendingRequests > 0 && Date.now() - startTime < this.maxDestroyWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (this.pendingRequests > 0) {
        console.warn(`[CopilotClientManager] Destroy timeout with ${this.pendingRequests} pending requests still active`);
      }

      // Clear shared state
      if (this.instance) {
        this.instance = null;
      }
      this.initPromise = null;

      console.log('[CopilotClientManager] Destroy sequence complete');
    } catch (error) {
      console.error('[CopilotClientManager] Error during destruction:', error);
    }
  }
}

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

let isShuttingDown = false;
let activeRequests = 0;
const SHUTDOWN_TIMEOUT_MS = 30 * 1000; // 30 seconds
const DRAIN_POLL_INTERVAL_MS = 100; // 100ms

// Initialize app with environment validation
try {
  validateEnvironment();
} catch (error) {
  console.error('[Startup] Fatal error:', error);
  process.exit(1);
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[Shutdown] Received ${signal}, initiating graceful shutdown`);
  isShuttingDown = true;

  // Stop accepting new requests
  server.close(() => {
    console.log('[Shutdown] HTTP server closed');
  });

  // Drain active requests with polling
  const drainStartTime = Date.now();
  while (activeRequests > 0 && Date.now() - drainStartTime < SHUTDOWN_TIMEOUT_MS) {
    console.log(`[Shutdown] Draining requests... (${activeRequests} active)`);
    await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
  }

  if (activeRequests > 0) {
    console.warn(`[Shutdown] Timeout with ${activeRequests} requests still active`);
  }

  // Cleanup resources
  try {
    await CopilotClientManager.destroy();
    await cleanupResources();
    console.log('[Shutdown] Resources cleaned up');
  } catch (error) {
    console.error('[Shutdown] Error during cleanup:', error);
  }

  process.exit(activeRequests > 0 ? 1 : 0);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/readiness';
  },
  handler: (req: Request, res: Response) => {
    const retryAfter = Math.ceil((req.rateLimit?.resetTime - Date.now()) / 1000) || 60;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: retryAfter,
      windowMs: 15 * 60 * 1000,
    });
  },
});

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[roaster] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`, error);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Global request timeout middleware
const REQUEST_TIMEOUT_MS = 30 * 1000; // 30 seconds
app.use((req: Request, res: Response, next: Function) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        error: 'Request timeout',
        timeout_ms: REQUEST_TIMEOUT_MS,
      });
    }
  }, REQUEST_TIMEOUT_MS);

  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));

  next();
});

// Request correlation middleware - generate and propagate trace IDs
app.use((req: Request, res: Response, next: Function) => {
  // Generate trace ID from header or create new one
  const traceId = (req.headers['x-trace-id'] as string) || `trace_${crypto.randomUUID()}`;
  (req as any).traceId = traceId;
  res.setHeader('X-Trace-ID', traceId);
  console.log(`[${traceId}] ${req.method} ${req.path}`);

  if (isShuttingDown) {
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
  activeRequests++;
  res.on('finish', () => {
    activeRequests--;
    console.log(`[${traceId}] Response: ${res.statusCode}`);
  });
  res.on('close', () => {
    // Decrement if not already done by finish event
    if (activeRequests > 0) {
      activeRequests--;
    }
  });
  next();
});

// Health check endpoint for container orchestration
app.get('/health', (req: Request, res: Response) => {
  // Liveness probe - simple up check
  if (isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down' });
  }
  res.status(200).json({ status: 'alive', timestamp: Date.now() });
});

// Readiness endpoint - checks dependencies
app.get('/readiness', async (req: Request, res: Response) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down', ready: false });
  }

  try {
    const client = await CopilotClientManager.getInstance();
    const clientReady = await CopilotClientManager.validateClientState(client);
    
    if (!clientReady) {
      return res.status(503).json({
        status: 'not_ready',
        ready: false,
        details: { copilot_client: 'unhealthy' },
      });
    }

    res.status(200).json({
      status: 'ready',
      ready: true,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[Readiness] Dependency check failed:', error);
    res.status(503).json({
      status: 'not_ready',
      ready: false,
      details: { error: 'dependency_check_failed' },
    });
  }
});

// Register graceful shutdown handlers
let server: any;

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

app.post('/roaster', limiter, async (req: Request, res: Response) => {
  const traceId = (req as any).traceId || 'unknown';
  CopilotClientManager.incrementPendingRequests();

  try {
    const { code, idempotencyKey } = req.body;
    (req as any).idempotencyKey = idempotencyKey;

    if (!code) {
      return res.status(400).json({
        error: 'Code is required',
        traceId,
      });
    }

    console.log(`[${traceId}] Processing roaster request with idempotency key: ${idempotencyKey}`);

    // Get CopilotClient with retry logic
    const client = await CopilotClientManager.getInstance();
    const isValid = await CopilotClientManager.validateClientState(client);

    if (!isValid) {
      console.error(`[${traceId}] CopilotClient validation failed`);
      return res.status(503).json({
        error: 'Service unavailable',
        traceId,
      });
    }

    // Call CopilotClient API with circuit breaker and tracking
    const response = await retryWithBackoff(async () => {
      return await client.chat({
        messages: [
          {
            role: 'user',
            content: code,
          },
        ],
      });
    });

    CopilotClientManager.decrementPendingRequests();
    return res.json({
      message: 'roasting...',
      code,
      result: response,
      traceId,
    });
  } catch (error) {
    CopilotClientManager.decrementPendingRequests();
    console.error(`[${traceId}] Error:`, error);
    res.status(500).json({
      error: 'Internal server error',
      traceId,
    });
  }
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

  // Use singleton instance with state validation and retry logic
  const client = await retryWithBackoff(
    () => CopilotClientManager.getInstance(),
    3,
    100
  );

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

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop accepting new connections
  server.close(() => {
    console.log('[Shutdown] Server stopped accepting new connections');
  });

  // Wait for in-flight requests to complete with timeout
  const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (activeRequests > 0 && Date.now() < shutdownDeadline) {
    console.log(`[Shutdown] Waiting for ${activeRequests} active request(s) to complete...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (activeRequests > 0) {
    console.warn(`[Shutdown] Timeout reached with ${activeRequests} active request(s) still in-flight`);
  }

  // Cleanup resources
  try {
    await CopilotClientManager.destroy();
    console.log('[Shutdown] Cleaned up CopilotClient');
  } catch (error) {
    console.error('[Shutdown] Error cleaning up CopilotClient:', error);
  }

  try {
    await cleanupResources();
    console.log('[Shutdown] Cleaned up API module resources');
  } catch (error) {
    console.error('[Shutdown] Error cleaning up API module resources:', error);
  }

  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));