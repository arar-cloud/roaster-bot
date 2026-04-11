import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Retry utility with exponential backoff, jitter, timeouts, and enhanced logging
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100,
  operation: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
        idempotencyStore.set(`validate-token:${idempotencyKey}`, result);
      console.log(JSON.stringify({
        level: 'INFO',
        type: 'TOKEN_VALIDATED',
        operation: 'validate-token',
        idempotencyKey,
      }));
      return res.json(result);
    } else {
      const result = { error: 'GitHub API error', statusCode: response.status };
      idempotencyStore.set(`validate-token:${idempotencyKey}`, result);
      return res.status(500).json(result);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      level: 'ERROR',
      type: 'TOKEN_VALIDATION_ERROR',
      operation: 'validate-token',
      idempotencyKey,
      errorMessage: errorMsg,
      errorStack: error instanceof Error ? error.stack : undefined,
    }));return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.log(`[RETRY] ${operation} attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError || new Error(`${operation} failed after ${maxRetries + 1} attempts`);
}

// Token validation utility
function validateGitHubToken(token: string): { valid: boolean; error?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token missing or invalid type' };
  }
  if (token.length < 20) {
    return { valid: false, error: 'Token too short' };
  }
  // Additional validation: check for GitHub token patterns (ghp_, ghu_, ghs_, ghr_)
  if (!token.match(/^(ghp_|ghu_|ghs_|ghr_)/)) {
    return { valid: false, error: 'Invalid GitHub token format' };
  }
  return { valid: true };
}

// Structured logging for observability
class StructuredLogger {
  private requestId: string;
  constructor(requestId: string) {
    this.requestId = requestId;
  }
  private log(level: string, operation: string, message: string, metadata?: Record<string, unknown>): void {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      requestId: this.requestId,
      operation,
      message,const startTime = Date.now();
  const operationContext = { operation, requestId: crypto.randomUUID(), startTime: new Date().toISOString() };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > totalTimeoutMs) {
      const timeoutError = new Error(`${operation} exceeded total timeout of ${totalTimeoutMs}ms after ${attempt} attempts`);
      console.error(JSON.stringify({
        level: 'ERROR',
        type: 'OPERATION_TIMEOUT',
        ...operationContext,
        attempt: attempt + 1,
        elapsedMs,
        errorMessage: timeoutError.message,
        errorStack: timeoutError.stack,
      }));
      throw timeoutError;
    }

    try {
      const attemptStartMs = Date.now();
      // Per-attempt timeout: use remaining total timeout or default
      const attemptTimeoutMs = Math.min(10000, totalTimeoutMs - elapsedMs); // 10s per attempt
      const result = await Promise.race([
        fn(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`Attempt timeout after ${attemptTimeoutMs}ms`)), attemptTimeoutMs)
        ),
      ]);
      const attemptDurationMs = Date.now() - attemptStartMs;
      console.log(JSON.stringify({
        level: 'INFO',
        type: 'OPERATION_SUCCESS',
        ...operationContext,
        attempt: attempt) + 1,
        attemptDurationMs,
        totalElapsedMs: Date.now() - startTime,
      }));
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isTransient = isTransientError(lastError);
      const errorContext = createErrorContext(attempt, maxRetries, operation, lastError);

      ...metadata
    }));
  }
  info(operation: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('INFO', operation, message, metadata);
  }
  warn(operation: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('WARN', operation, message, metadata);
  }
  error(operation: string, message: string, metadata?: Record<string, unknown>): void {
    this.log('ERROR', operation, message, metadata);
  }
}

// Circuit breaker states
type CircuitState = 'closed' | 'open' | 'half-open';

// Circuit breaker and bulkhead implementation for external API calls
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private readonly failureThreshold = 5;
  private readonly successThreshold = 2;
  private readonly resetTimeoutMs = 30000; // 30s
  private activeRequests = 0;
  private readonly maxConcurrency = 10; // Bulkhead: max concurrent requests
  private readonly name: string;

  constructor(name: string = 'api-circuit') {
    this.name = name;
  }

  async executeAsync<T>(fn: () => Promise<T>, operationName: string = 'operation'): Promise<T> {
    // Check if circuit should reset
    if (this.state === 'open' && this.lastFailureTime) {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'half-open';
        this.successCount = 0;
        console.info(`[CIRCUIT] ${this.name} transitioning to half-open state`);
      }
    }

    // Reject if open
    if (this.state === 'open') {
      const error = new Error(`Circuit breaker ${this.name} is OPEN - rejecting request`);
      console.warn(`[CIRCUIT] ${this.name} is open, rejecting operation: ${operationName}`);
      throw error;
    }

    // Bulkhead: enforce max concurrency
    if (this.activeRequests >= this.maxConcurrency) {
      const error = new Error(`Circuit breaker ${this.name} bulkhead limit (${this.maxConcurrency}) exceeded`);
      console.warn(`[CIRCUIT] ${this.name} bulkhead limit reached, rejecting operation: ${operationName}`);
      throw error;
    }

    this.activeRequests++;
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.activeRequests--;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        console.info(`[CIRCUIT] ${this.name} circuit CLOSED after successful recovery`);
      }
    } else if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      console.error(`[CIRCUIT] ${this.name} circuit OPEN after ${this.failureCount} failures`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getMetrics(): { state: CircuitState; failureCount: number; activeRequests: number; maxConcurrency: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      activeRequests: this.activeRequests,
      maxConcurrency: this.maxConcurrency
    };
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

// Validate environment variables at startup
function validateEnvironment(): void {
  const requiredEnvVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

validateEnvironment();

// Initialize CopilotClient with error handling
let copilotClient: CopilotClient | null = null;
try {
  const token = process.env.GITHUB_TOKEN!;
  const tokenValidation = validateGitHubToken(token);
  if (!tokenValidation.valid) {
    console.error(`[FATAL] GitHub token validation failed: ${tokenValidation.error}`);
    process.exit(1);
  }
  copilotClient = new CopilotClient({
    token: token
  });
  console.log('[INIT] CopilotClient initialized successfully');
} catch (error) {
  console.error('[FATAL] CopilotClient initialization failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;

// Track in-flight requests for graceful shutdown
let inFlightRequests = 0;
let isShuttingDown = false;

app.use((req: Request, res: Response, next) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
  inFlightRequests++;
  res.on('finish', () => {
    inFlightRequests--;
  });
  next();
});

const server = app.listen(port, () => {
  console.log(JSON.stringify({
    level: 'INFO',
    type: 'SERVER_STARTED',
    port,
    timestamp: new Date().toISOString(),
  }));
});

// Graceful shutdown on SIGTERM
process.on('SIGTERM', () => {
  console.log(JSON.stringify({
    level: 'INFO',
    type: 'SIGTERM_RECEIVED',
    timestamp: new Date().toISOString(),
    inFlightRequests,
  }));
  isShuttingDown = true;
  
  // Give in-flight requests 30 seconds to complete
  const shutdownTimeoutMs = 30000;
  const shutdownStart = Date.now();
  
  const drainInterval = setInterval(() => {
    const elapsedMs = Date.now() - shutdownStart;
    console.log(JSON.stringify({
      level: 'INFO',
      type: 'SHUTDOWN_DRAINING',
      inFlightRequests,
      elapsedMs,
      maxWaitMs: shutdownTimeoutMs,
    }));
    
    if (inFlightRequests === 0 || elapsedMs > shutdownTimeoutMs) {
      clearInterval(drainInterval);
      server.close(() => {
        console.log(JSON.stringify({
          level: 'INFO',
          type: 'SERVER_CLOSED',
          timestamp: new Date().toISOString(),
        }));
        process.exit(0);
      });
    }
  }, 1000);
});

// Initialize circuit breaker for CopilotClient calls
const copilotCircuitBreaker = new CircuitBreaker('copilot-client');

// Idempotency key cache to prevent duplicate operations
class IdempotencyKeyStore {
  private store = new Map<string, { result: unknown; timestamp: number }>();
  private readonly ttlMs = 300000; // 5 minutes

  set(key: string, result: unknown): void {
    this.store.set(key, { result, timestamp: Date.now() });
    if (this.store.size % 1000 === 0) {
      this.cleanup();
    }
  }

  get(key: string): unknown | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.result;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}

const idempotencyStore = new IdempotencyKeyStore();

// Apply security middleware
app.use(helmet());
app.use((req: Request, res: Response, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Set timeout for all routes (30 seconds)
app.use((req: Request, res: Response, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000, () => {
    console.error(`[TIMEOUT] Response timeout for ${req.method} ${req.path}`);
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timeout' });
    }
  });
  next();
});

// Health check and readiness probe endpoints
app.get('/health', (req: Request, res: Response) => {
  const circuitMetrics = copilotCircuitBreaker.getMetrics();
  const status = circuitMetrics.state === 'closed' ? 'healthy' : 'degraded';
  res.status(circuitMetrics.state === 'closed' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    circuitBreaker: circuitMetrics,
  });
});

app.get('/ready', (req: Request, res: Response) => {
  const circuitMetrics = copilotCircuitBreaker.getMetrics();
  // Readiness: circuit breaker not open and concurrency not saturated
  const isReady = circuitMetrics.state !== 'open' && circuitMetrics.activeRequests < circuitMetrics.maxConcurrency * 0.8;
  res.status(isReady ? 200 : 503).json({
    ready: isReady,
    timestamp: new Date().toISOString(),
    circuitBreaker: circuitMetrics,
  });
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    const retryAfterSec = Math.ceil(req.rateLimit!.resetTime / 1000 - Date.now() / 1000);
    res.set('Retry-After', Math.max(1, retryAfterSec).toString());
    res.status(429).json({
      error: 'Too many requests, please retry later',
      retryAfter: Math.max(1, retryAfterSec),
      resetTime: new Date(req.rateLimit!.resetTime).toISOString(),
    });
  },
  skip: (req: Request) => {
    return req.path === '/health' || req.path === '/ready';
  },
});

// Input validation helper
function validateWebhookPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const payload = body as Record<string, unknown>;
  return 'action' in payload || 'event' in payload || 'type' in payload;
}

app.use(express.json({
  limit: '10mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
    if (buf.length > 10 * 1024 * 1024) {
      throw new Error('Payload exceeds size limit');
    }
  }
}));

app.get('/', limiter, (req, res) => {
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
  // Extract or generate idempotency key for deduplication
  const idempotencyKey = req.get('Idempotency-Key') || crypto.randomUUID();
  const cachedResult = idempotencyStore.get(idempotencyKey);
  if (cachedResult) {
    console.log(`[DEDUP] Returning cached result for idempotency key: ${idempotencyKey}`);
    return res.status(200).json(cachedResult);
  }
  // Webhook signature verification with strict HMAC-SHA256 validation
  try {
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;

    if (!signature) {
      console.warn('[SECURITY] Webhook request missing signature header');
      return res.status(401).json({ error: 'Missing signature header' });
    }

    if (!webhookSecret) {
      console.error('[FATAL] WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      console.warn('[SECURITY] Webhook request missing raw body');
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
      console.warn('[SECURITY] Webhook signature mismatch - rejecting request');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.info('[SECURITY] Webhook signature verified successfully');
  } catch (err) {
    console.error('[ERROR] Signature verification failed:', err);
    return res.status(500).json({ error: 'Signature verification error' });
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

    const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
    const logger = new StructuredLogger(requestId);

    // Validate webhook payload structure
    if (!validateWebhookPayload(req.body)) {
      logger.warn('parse_validation', 'Invalid webhook payload structure', { body: req.body });
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Extract and validate user messages
    const userMessages = req.body?.messages || req.body?.content || [];
    if (!Array.isArray(userMessages)) {
      logger.warn('parse_validation', 'userMessages is not an array', { userMessages });
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    if (userMessages.length === 0) {
      logger.warn('parse_validation', 'No messages provided', {});
      return res.status(400).json({ error: 'No messages to process' });
    }

    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    if (!lastMessage) {
      logger.warn('parse_validation', 'No user message found in payload', { messageCount: userMessages.length });
      return res.status(400).json({ error: 'No user message found' });
    }

    const prompt = lastMessage.content || "Roast me.";

    // Create session with retry logic for transient failures
    let session;
    try {
      session = await retryWithBackoff(
        async () => {
          logger.info('session_creation', 'Attempting to create session', {});
          return await client.createSession({
            model: "gpt-4o",
            streaming: true,
            systemMessage: {
              mode: "replace",
              content: systemPrompt
            }
          });
        },
        3,
        100,
        'session_creation'
      );
      logger.info('session_created', 'Session created successfully', {});
    } catch (sessionError) {
      logger.error('session_creation_failed', 'Failed to create session after retries', {
        error: sessionError instanceof Error ? sessionError.message : String(sessionError)
      });
      if (!res.headersSent) res.status(503).json({ error: 'Failed to initialize session' });
      return;
    }

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
    const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
    const logger = new StructuredLogger(requestId);
    logger.error('agent_processing', 'Error processing roast request', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    await client.stop();
  }
});

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// Graceful shutdown handler
function gracefulShutdown(signal: string): void {
  console.log(`[SHUTDOWN] Received ${signal}, starting graceful shutdown`);

  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('[SHUTDOWN] Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error: Error) => {
  console.error('[FATAL] Uncaught exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});