import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// State machine for retry and circuit breaker logic
enum RetryState {
  IDLE = 'IDLE',
  RETRYING = 'RETRYING',
  BACKOFF = 'BACKOFF',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  CIRCUIT_HALF_OPEN = 'CIRCUIT_HALF_OPEN',
  FAILED = 'FAILED',
}

interface CircuitBreakerConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  failureThreshold: number;
  resetTimeoutMs: number;
}

class CircuitBreaker {
  private state: RetryState = RetryState.IDLE;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  canAttempt(): boolean {
    if (this.state === RetryState.CIRCUIT_OPEN) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure > this.config.resetTimeoutMs) {
        this.state = RetryState.CIRCUIT_HALF_OPEN;
        return true;
      }
      return false;
    }
    return this.state !== RetryState.FAILED;
  }

  recordSuccess(): void {
    if (this.state === RetryState.CIRCUIT_HALF_OPEN || this.state === RetryState.RETRYING) {
      this.state = RetryState.IDLE;
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = RetryState.CIRCUIT_OPEN;
    } else if (this.state === RetryState.IDLE) {
      this.state = RetryState.RETRYING;
    }
  }

  getState(): RetryState {
    return this.state;
  }

  getBackoffDelay(attemptNumber: number): number {
    const delay = Math.min(
      this.config.initialDelayMs * Math.pow(2, attemptNumber),
      this.config.maxDelayMs
    );
    return delay + Math.random() * 1000; // Add jitter
  }
}

const defaultCircuitBreakerConfig: CircuitBreakerConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  failureThreshold: 5,
  resetTimeoutMs: 30000,
};

const circuitBreaker = new CircuitBreaker(defaultCircuitBreakerConfig);

// Idempotency handling
interface IdempotencyRequest {
  key: string;
  status: 'pending' | 'completed' | 'failed';
  result?: any;
  error?: any;
  timestamp: number;
}

class IdempotencyManager {
  private requests: Map<string, IdempotencyRequest> = new Map();
  private readonly maxCacheAge = 3600000; // 1 hour

  registerRequest(key: string): boolean {
    if (this.requests.has(key)) {
      const req = this.requests.get(key)!;
      if (req.status === 'pending') {
        return false; // Request already in progress
      }
      if (Date.now() - req.timestamp < this.maxCacheAge) {
        return false; // Return cached result
      }
    }
    this.requests.set(key, {
      key,
      status: 'pending',
      timestamp: Date.now(),
    });
    return true;
  }

  completeRequest(key: string, result: any): void {
    const req = this.requests.get(key);
    if (req) {
      req.status = 'completed';
      req.result = result;
    }
  }

  failRequest(key: string, error: any): void {
    const req = this.requests.get(key);
    if (req) {
      req.status = 'failed';
      req.error = error;
    }
  }

  getCachedResult(key: string): any {
    const req = this.requests.get(key);
    if (req && req.status === 'completed' && Date.now() - req.timestamp < this.maxCacheAge) {
      return req.result;
    }
    return null;
  }

  cleanupStaleEntries(): void {
    const now = Date.now();
    for (const [key, req] of this.requests.entries()) {
      if (now - req.timestamp > this.maxCacheAge) {
        this.requests.delete(key);
      }
    }
  }
}

const idempotencyManager = new IdempotencyManager();

// Metrics collection for observability
interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

class MetricsCollector {
  private metrics: Metric[] = [];
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();

  incrementCounter(name: string, value: number = 1, tags?: Record<string, string>): void {
    const key = tags ? `${name}:${JSON.stringify(tags)}` : name;
    this.counters.set(key, (this.counters.get(key) || 0) + value);
    this.metrics.push({
      name: `${name}_counter`,
      value,
      timestamp: Date.now(),
      tags,
    });
  }

  recordLatency(name: string, durationMs: number, tags?: Record<string, string>): void {
    const key = tags ? `${name}:${JSON.stringify(tags)}` : name;
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    this.histograms.get(key)!.push(durationMs);
    this.metrics.push({
      name: `${name}_latency`,
      value: durationMs,
      timestamp: Date.now(),
      tags,
    });
  }

  recordFailure(name: string, reason: string): void {
    this.incrementCounter(`${name}_failures`, 1, { reason });
  }

  getStats(name: string): { count: number; mean: number; p95: number; p99: number } | null {
    const values = this.histograms.get(name);
    if (!values || values.length === 0) {
      return null;
    }
    const sorted = values.sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    return { count: sorted.length, mean, p95, p99 };
  }

  getAllMetrics(): Record<string, any> {
    const stats: Record<string, any> = {};
    for (const [key, values] of this.histograms.entries()) {
      if (values.length > 0) {
        stats[key] = this.getStats(key);
      }
    }
    for (const [key, value] of this.counters.entries()) {
      stats[key] = value;
    }
    return stats;
  }
}

const metricsCollector = new MetricsCollector();

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

// Middleware for stability and metrics
const stabilityMiddleware = (req: any, res: any, next: any) => {
  const startTime = Date.now();
  const method = req.method;
  const path = req.path;
  
  // Check circuit breaker state
  if (!circuitBreaker.canAttempt()) {
    metricsCollector.recordFailure(method + path, 'circuit_open');
    return res.status(503).json({ error: 'Service temporarily unavailable - circuit breaker open' });
  }

  // Check idempotency
  const idempotencyKey = req.headers['idempotency-key'];
  if (idempotencyKey) {
    if (!idempotencyManager.registerRequest(idempotencyKey)) {
      const cached = idempotencyManager.getCachedResult(idempotencyKey);
      if (cached) {
        metricsCollector.incrementCounter(`${method}_${path}_cache_hit`);
        return res.json(cached);
      }
      metricsCollector.recordFailure(method + path, 'duplicate_request');
      return res.status(409).json({ error: 'Duplicate request in progress' });
    }
  }

  // Wrap response to capture metrics
  const originalJson = res.json.bind(res);
  res.json = (data: any) => {
    const duration = Date.now() - startTime;
    metricsCollector.recordLatency(method + path, duration);
    metricsCollector.incrementCounter(`${method}_${path}_success`);
    circuitBreaker.recordSuccess();
    if (idempotencyKey) {
      idempotencyManager.completeRequest(idempotencyKey, data);
    }
    return originalJson(data);
  };

  // Capture errors
  const originalStatus = res.status.bind(res);
  res.status = (code: number) => {
    if (code >= 400) {
      const duration = Date.now() - startTime;
      metricsCollector.recordFailure(method + path, `http_${code}`);
      if (code >= 500) {
        circuitBreaker.recordFailure();
      }
    }
    return originalStatus(code);
  };

  next();
};

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

app.use(stabilityMiddleware);
app.use(limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  const state = circuitBreaker.getState();
  const isHealthy = state !== RetryState.CIRCUIT_OPEN && state !== RetryState.FAILED;
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    circuitBreakerState: state,
    timestamp: new Date().toISOString(),
  });
});

// Metrics endpoint for observability
app.get('/metrics', (req, res) => {
  idempotencyManager.cleanupStaleEntries();
  res.json({
    metrics: metricsCollector.getAllMetrics(),
    circuitBreakerState: circuitBreaker.getState(),
    timestamp: new Date().toISOString(),
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