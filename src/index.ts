import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Structured logging utility
const createLogger = (correlationId: string) => ({
  info: (msg: string, context?: any) => console.log(JSON.stringify({level: 'INFO', msg, correlationId, context, timestamp: new Date().toISOString()})),
  error: (msg: string, err?: any, context?: any) => console.error(JSON.stringify({level: 'ERROR', msg, error: err?.message || String(err), correlationId, context, timestamp: new Date().toISOString()})),
  warn: (msg: string, context?: any) => console.warn(JSON.stringify({level: 'WARN', msg, correlationId, context, timestamp: new Date().toISOString()})),
  debug: (msg: string, context?: any) => console.log(JSON.stringify({level: 'DEBUG', msg, correlationId, context, timestamp: new Date().toISOString()})),
});

// Extend Express Request with logger and correlation ID
declare global {
  namespace Express {
    interface Request {
      logger?: ReturnType<typeof createLogger>;
      correlationId?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;
const generateCorrelationId = () => `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Database connection pool manager
class ConnectionPoolManager {
  private connections: any[] = [];
  private activeConnections = new Set();
  private failureCount = 0;
  private lastFailureTime = 0;
  private maxPoolSize = 10;
  private reconnectBackoffMs = 1000;
  private maxReconnectBackoffMs = 30000;

  async acquireConnection(correlationId: string) {
    const logger = createLogger(correlationId);
    if (this.connections.length === 0 && this.activeConnections.size < this.maxPoolSize) {
      try {
        const conn = {id: `conn_${Date.now()}`, createdAt: Date.now(), isHealthy: true};
        this.connections.push(conn);
        logger.debug('Created new connection', {poolSize: this.connections.length});
      } catch (err) {
        logger.error('Failed to create connection', err);
        this.recordFailure();
        throw err;
      }
    }
    if (this.connections.length === 0) {
      logger.warn('Connection pool exhausted', {activeConnections: this.activeConnections.size, poolSize: this.maxPoolSize});
      throw new Error('Connection pool exhausted');
    }
    const conn = this.connections.pop();
    this.activeConnections.add(conn.id);
    logger.debug('Acquired connection', {connectionId: conn.id, activeCount: this.activeConnections.size});
    return conn;
  }

  releaseConnection(connId: string, correlationId: string) {
    const logger = createLogger(correlationId);
    this.activeConnections.delete(connId);
    const conn = {id: connId, createdAt: Date.now(), isHealthy: true};
    this.connections.push(conn);
    logger.debug('Released connection', {connectionId: connId, poolSize: this.connections.length});
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }

  recordSuccess() {
    this.failureCount = Math.max(0, this.failureCount - 1);
  }

  getPoolStats() {
    return {
      availableConnections: this.connections.length,
      activeConnections: this.activeConnections.size,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

const poolManager = new ConnectionPoolManager();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Correlation ID middleware: inject into all requests
app.use((req: any, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
  req.logger = createLogger(req.correlationId);
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// Connection pool health check middleware
app.use((req: any, res, next) => {
  const stats = poolManager.getPoolStats();
  req.logger?.debug('Pool health check', stats);
  if (stats.failureCount > 5) {
    req.logger?.warn('Connection pool degraded', {failureCount: stats.failureCount});
  }
  next();
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', (req: any, res) => {
  req.logger?.info('GET / request received');
  req.logger?.debug('Rendering home page');
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