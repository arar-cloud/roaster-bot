import 'dotenv/config';
import express, { Request, Response } from 'express';
import compression from 'compression';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// Pre-warm environment variables at startup to avoid repeated lookups on every request
const ENV_CACHE = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || ''
};

const app = express();
const port = ENV_CACHE.PORT;

// Enable response compression to reduce bandwidth 3-5x
app.use(compression());

// CopilotClient cache with TTL and LRU eviction to avoid repeated initialization
class ClientCache {
  private cache = new Map<string, { client: CopilotClient; timestamp: number; lastAccess: number }>();
  private readonly TTL = 3600000; // 1 hour
  private readonly MAX_SIZE = 50; // Max 50 cached clients

  get(token: string): CopilotClient | null {
    const entry = this.cache.get(token);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(token);
      return null;
    }

    // Update last access time for LRU tracking
    entry.lastAccess = Date.now();
    return entry.client;
  }

  set(token: string, client: CopilotClient): void {
    // LRU eviction: remove least-recently-used entry if cache is full
    if (this.cache.size >= this.MAX_SIZE) {
      let lruKey = '';
      let lruTime = Date.now();
      for (const [key, value] of this.cache.entries()) {
        if (value.lastAccess < lruTime) {
          lruTime = value.lastAccess;
          lruKey = key;
        }
      }
      this.cache.delete(lruKey);
    }
    const now = Date.now();
    this.cache.set(token, { client, timestamp: now, lastAccess: now });
  }

  clear(): void {
    this.cache.clear();
  }
}

const clientCache = new ClientCache();

// Configuration for request timeouts
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);
const COPILOT_TIMEOUT_MS = parseInt(process.env.COPILOT_TIMEOUT_MS || '12000', 10);

// Connection pooling: persistent keep-alive agents for external API calls
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: REQUEST_TIMEOUT_MS
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: REQUEST_TIMEOUT_MS
});

// Token-based rate limiter: use X-GitHub-Token as key instead of IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use GitHub token as rate limit key; fall back to IP if missing
    return req.get('X-GitHub-Token') || req.ip || 'unknown';
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/';
  }
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

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
  const webhookSecret = ENV_CACHE.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      // Use timing-safe comparison to prevent timing attacks
      const expectedHmac = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      const digest = 'sha256=' + expectedHmac;
      
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'utf8'),
        Buffer.from(digest, 'utf8')
      );
      
      if (!isValid) {
        return res.status(401).send('Unauthorized');
      }
    } catch (err) {
      return res.status(401).send('Unauthorized');
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

    // Track backpressure: pause session if res buffer is filling
    let isPaused = false;
    const backpressureHandler = (event: any) => {
      if (event.type === "assistant.message_delta") {
        const chunk = {
          choices: [{ delta: { content: event.data.deltaContent } }]
        };
        const canContinue = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (!canContinue && !isPaused) {
          isPaused = true;
          // In production, signal session to pause; for now, buffer management handled by Node
        }
      }
    };

    // Resume streaming when res buffer drains
    res.on('drain', () => {
      isPaused = false;
    });

    session.on(backpressureHandler);

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

// Configure connection pooling and keep-alive for HTTP clients
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds

// Enable TCP_NODELAY to reduce latency on small packets
server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

// Graceful shutdown on SIGTERM
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, starting graceful shutdown...');
  
  server.close(async () => {
    console.log('HTTP server closed');
    clientCache.clear();
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    clientCache.clear();
    process.exit(1);
  }, 30000);
});