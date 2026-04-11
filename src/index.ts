import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { globalQueue } from './queue.js';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      correlationId?: string;
    }
  }
}

// Structured logging helper
interface LogContext {
  correlationId: string;
  timestamp: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
  error?: { message: string; stack?: string };
  metadata?: Record<string, unknown>;
}

function structuredLog(context: Omit<LogContext, 'timestamp'>) {
  const log: LogContext = {
    ...context,
    timestamp: new Date().toISOString()
  };
  console.log(JSON.stringify(log));
}

// Correlation ID middleware
app.use((req: Request, res: Response, next) => {
  req.correlationId = req.headers['x-correlation-id'] as string || crypto.randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '30000', 10);
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '5', 10);

// Helper function to make API calls with timeout
async function callCopilotWithTimeout<T>(
  fn: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`API call timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Helper function for safe environment variable access
function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  return value ?? defaultValue ?? '';
}

// Circuit breaker state for initialization failures
interface CircuitBreakerState {
  failureCount: number;
  lastFailureTime: number;
  state: 'closed' | 'open' | 'half-open';
}

const circuitBreakerState: CircuitBreakerState = {
  failureCount: 0,
  lastFailureTime: 0,
  state: 'closed'
};

// Validate critical environment variables at startup
function validateEnvironment(): boolean {
  const requiredVars = ['GITHUB_TOKEN'];
  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[FATAL] Required environment variables missing: ${missing.join(', ')}`);
    circuitBreakerState.failureCount++;
    circuitBreakerState.lastFailureTime = Date.now();
    circuitBreakerState.state = 'open';
    return false;
  }
  return true;
}

// Strict validation: fail fast on missing GITHUB_TOKEN
if (!validateEnvironment()) {
  console.error('[STARTUP] Aborting: GITHUB_TOKEN validation failed');
  process.exit(1);
}

// Per-client rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.correlationId || req.ip || 'unknown'
});

// Queue-level rate limiting (prevents endpoint/queue overlap)
const queueRateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  limit: MAX_CONCURRENT_REQUESTS,  // Max concurrent queue tasks
  message: 'Queue is at capacity, please retry later',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'global-queue'  // Global limit across all clients
});

// Queue backpressure check
function checkQueueCapacity(): boolean {
  const pending = globalQueue.getPendingCount();
  return pending < MAX_CONCURRENT_REQUESTS;
}

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Initialize Copilot client with error handling
let copilotClient: CopilotClient | null = null;
let copilotInitError: Error | null = null;

try {
  copilotClient = new CopilotClient();
  console.log('[CopilotClient] Initialized successfully');
} catch (error) {
  copilotInitError = error instanceof Error ? error : new Error(String(error));
  console.error('[CopilotClient] Initialization failed:', copilotInitError.message);
  console.warn('[CopilotClient] Operating in degraded mode - queue tasks will fail gracefully');
}

// Register queue handlers for critical async operations
globalQueue.registerHandler('process-pr-review', async (task) => {
  try {
    const { title, body, headRef } = task.payload as any;
    if (!title || !headRef) {
      throw new Error('Invalid PR review payload: missing title or headRef');
    }

    if (!copilotClient) {
      throw new Error('CopilotClient not initialized: ' + (copilotInitError?.message || 'unknown reason'));
    }

    const result = await copilotClient.getCompletions({
      prompt: `Review this PR: ${title}\n\n${body || '(no description)'}`,
    });

    return {
      taskId: task.id,
      success: true,
      result: result,
      attempts: task.attempts,
    };
  } catch (error) {
    throw error;
  }
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

app.post('/agent', limiter, queueRateLimiter, async (req: Request, res: Response) => {
  const correlationId = req.correlationId!;
  
  // Check queue capacity before processing
  if (!checkQueueCapacity()) {
    structuredLog({
      correlationId,
      severity: 'warn',
      component: 'webhook',
      message: 'Queue at capacity'
    });
    return res.status(429).json({ error: 'Queue at capacity', retryAfter: 60 });
  }
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET ?? '';

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody || typeof rawBody !== 'string') {
      structuredLog({
        correlationId,
        severity: 'warn',
        component: 'webhook',
        message: 'Missing raw body'
      });
      return res.status(400).send('Missing raw body.');
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
      structuredLog({
        correlationId,
        severity: 'warn',
        component: 'webhook',
        message: 'Invalid webhook signature',
        metadata: { expectedDigest: digest.substring(0, 20), receivedDigest: signature.substring(0, 20) }
      });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token || typeof token !== 'string') {
    structuredLog({
      correlationId,
      severity: 'warn',
      component: 'webhook',
      message: 'Missing X-GitHub-Token'
    });
    return res.status(401).send('Missing X-GitHub-Token.');
  }

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });
  
  if (!client) {
    structuredLog({
      correlationId,
      severity: 'error',
      component: 'webhook',
      message: 'Failed to initialize Copilot client'
    });
    return res.status(500).send('Failed to initialize Copilot client.');
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

    const userMessages = (req.body?.messages as Array<any> | undefined) ?? [];
    const lastMessage = Array.isArray(userMessages) ? userMessages.filter((m: any) => m?.role === 'user').pop() : undefined;
    const prompt = (lastMessage?.content as string | undefined) ?? "Roast me.";

    // Check queue capacity to prevent overwhelming the system
    if (!checkQueueCapacity()) {
      structuredLog({
        correlationId,
        severity: 'warn',
        component: 'webhook',
        message: 'Queue at capacity, rejecting new task',
        metadata: { pendingTasks: globalQueue.getPendingCount(), maxConcurrent: MAX_CONCURRENT_REQUESTS }
      });
      res.status(503).json({ 
        error: 'Service temporarily unavailable - queue at capacity',
        correlationId,
        retryAfter: 5
      });
      return;
    }

    // Queue the roasting task for reliable processing
    const taskId = await globalQueue.enqueue(
      'process-pr-review',
      {
        title: 'Roast Request',
        body: prompt,
        headRef: 'roast-session',
      },
      { maxRetries: 3, priority: 'high', correlationId }
    );

    // Track correlation ID in queue for end-to-end tracing
    globalQueue.setCorrelationId(taskId, correlationId);

    res.setHeader('Content-Type', 'application/json');
    res.status(202).json({
      received: true,
      taskId,
      status: 'queued',
      message: 'Your roasting is being prepared...',
      correlationId
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    structuredLog({
      correlationId,
      severity: 'error',
      component: 'webhook',
      message: 'Webhook processing failed',
      error: { message: errorMessage, stack: errorStack }
    });
    
    if (!res.headersSent) res.status(500).json({ error: 'The roaster overheated.', correlationId });
  } finally {
    await client.stop();
  }
});

const server = app.listen(port, () => {
  console.log(`[Server] Listening on port ${port}`);
});

// Graceful shutdown handler for pending tasks
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.warn(`[Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }
  
  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}, starting graceful shutdown`);
  
  // Stop accepting new requests
  server.close(async () => {
    console.log('[Shutdown] HTTP server closed');
  });
  
  // Drain queue and wait for pending tasks
  try {
    console.log('[Shutdown] Draining queue tasks...');
    const shutdownTimeout = 10000;
    const startTime = Date.now();
    
    while (globalQueue.getPendingCount() > 0 && Date.now() - startTime < shutdownTimeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log('[Shutdown] Queue drained, exiting');
  } catch (error) {
    console.error('[Shutdown] Error during queue drain:', error);
  } finally {
    process.exit(0);
  }
}

// Health check endpoints
app.get('/health', (req: Request, res: Response) => {
  const health = {
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    copilotInitialized: copilotClient !== null,
    copilotError: copilotInitError?.message || null,
    circuitBreakerState: circuitBreakerState.state,
    queuePending: globalQueue.getPendingCount()
  };
  
  res.status(200).json(health);
});

app.get('/ready', (req: Request, res: Response) => {
  const isReady = 
    copilotClient !== null && 
    circuitBreakerState.state !== 'open' && 
    copilotInitError === null;
  
  if (isReady) {
    res.status(200).json({ ready: true, message: 'Service ready to receive requests' });
  } else {
    res.status(503).json({ 
      ready: false, 
      reason: copilotInitError?.message || 'Copilot client not initialized'
    });
  }
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));