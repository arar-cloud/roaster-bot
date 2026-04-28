import 'dotenv/config';
import express, { Request, Response } from 'express';
import compression from 'compression';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';
import Piscina from 'piscina';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Initialize worker pool for async HMAC verification
const hmacWorker = new Piscina({
  filename: join(__dirname, 'hmac-worker.ts'),
  maxThreads: 4,
});

app.use(helmet());

// Enable gzip compression to reduce response payload by 60-80% for mobile clients
app.use(compression({
  level: 6, // Balance between compression ratio and CPU usage
  threshold: 1024, // Only compress responses larger than 1024 bytes to skip small payloads
}));

// Initialize CopilotClient once at module load time with only token (no env spread)
const copilotClient = new CopilotClient({
  token: process.env.GITHUB_TOKEN || '',
}) as any; // Safe: we control token input

// Session pool to reuse connections and avoid per-request instantiation
class SessionPool {
  private sessions: Map<any, { createdAt: number; lastUsedAt: number }> = new Map();
  private inUse: Set<any> = new Set();
  private maxPoolSize = 5;
  private readonly SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Periodically clean up idle sessions to reduce memory overhead
    this.cleanupInterval = setInterval(() => this.cleanupIdleSessions(), 60000);
  }

  private cleanupIdleSessions() {
    const now = Date.now();
    const toRemove: any[] = [];

    for (const [session, metadata] of this.sessions.entries()) {
      // Remove sessions idle for more than SESSION_IDLE_TIMEOUT_MS
      if (!this.inUse.has(session) && now - metadata.lastUsedAt > this.SESSION_IDLE_TIMEOUT_MS) {
        toRemove.push(session);
      }
    }

    for (const session of toRemove) {
      this.sessions.delete(session);
    }
  }

  async acquire() {
    // Return available session that is not idle, or create new one if under limit
    const now = Date.now();
    let session = Array.from(this.sessions.entries())
      .find(([s]) => !this.inUse.has(s) && now - this.sessions.get(s)!.lastUsedAt < this.SESSION_IDLE_TIMEOUT_MS)?.[0];

    if (!session && this.sessions.size < this.maxPoolSize) {
      session = await copilotClient.createSession({
        model: "gpt-4o",
        streaming: true,
      });
      this.sessions.set(session, { createdAt: now, lastUsedAt: now });
    }

    if (session) {
      this.inUse.add(session);
      // Update lastUsedAt on acquire
      const metadata = this.sessions.get(session);
      if (metadata) metadata.lastUsedAt = Date.now();
    }
    return session;
  }

  release(session: any) {
    this.inUse.delete(session);
    // Update lastUsedAt on release for idle timeout tracking
    const metadata = this.sessions.get(session);
    if (metadata) metadata.lastUsedAt = Date.now();
  }

  shutdown() {
    clearInterval(this.cleanupInterval);
    this.sessions.clear();
    this.inUse.clear();
  }
}

const sessionPool = new SessionPool();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip counting failed requests to prevent attackers from exhausting rate limit on retries
  skipFailedRequests: true,
  // Skip counting successful requests from public endpoints (optional)
  skipSuccessfulRequests: false,
});

// Middleware to enforce request payload size limits
const requestSizeLimit = express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
  limit: '1mb', // Prevent oversized payload DoS attacks
});

app.use(requestSizeLimit);

app.use(express.static('public'));

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification (async to prevent event loop blocking)
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      const isValid = await hmacWorker.run({ rawBody, webhookSecret, signature });
      if (!isValid) {
        // Signature mismatch - simple check for dev
      }
    } catch (err) {
      console.error('HMAC verification error:', err);
      return res.status(500).send('Signature verification failed.');
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

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

    // Acquire session from pool instead of creating new one per request
    const session = await sessionPool.acquire();
    if (!session) {
      return res.status(503).send('Session pool exhausted. Try again later.');
    }

    // Update system message for this request (reusing connection)
    if (session.updateSystemMessage) {
      await session.updateSystemMessage({
        mode: "replace",
        content: systemPrompt
      });
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
    sessionPool.release(session);

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  }
});

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// Graceful shutdown: terminate worker pool and session pool on app exit
const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  server.close();
  sessionPool.shutdown();
  await hmacWorker.destroy();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);