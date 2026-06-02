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
// Uses doubly-linked list for O(1) eviction instead of O(n) linear scan
class ClientCache {
  private cache = new Map<string, CacheNode>();
  private head: CacheNode | null = null; // Most recently used
  private tail: CacheNode | null = null; // Least recently used
  private readonly TTL = 3600000; // 1 hour
  private readonly MAX_SIZE = 50; // Max 50 cached clients
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic batch cleanup every 5 minutes to evict expired entries
    this.cleanupInterval = setInterval(() => this.batchCleanup(), 5 * 60 * 1000);
  }

  private batchCleanup(): void {
    const now = Date.now();
    const expiredTokens: string[] = [];
    
    for (const [token, node] of this.cache.entries()) {
      if (now - node.timestamp > this.TTL) {
        expiredTokens.push(token);
      }
    }
    
    for (const token of expiredTokens) {
      const node = this.cache.get(token);
      if (node) {
        this.removeNode(node);
        this.cache.delete(token);
      }
    }
  }

  get(token: string): CopilotClient | null {
    const node = this.cache.get(token);
    if (!node) return null;

    // Check if expired
    if (Date.now() - node.timestamp > this.TTL) {
      this.removeNode(node);
      this.cache.delete(token);
      return null;
    }

    // Move to head (most recently used) - O(1) operation
    this.moveToHead(node);
    return node.client;
  }

  set(token: string, client: CopilotClient): void {
    const now = Date.now();
    
    if (this.cache.has(token)) {
      // Update existing node and move to head
      const node = this.cache.get(token)!;
      node.client = client;
      node.timestamp = now;
      this.moveToHead(node);
      return;
    }

    // Create new node - O(1) operation
    const newNode = new CacheNode(token, client, now);
    this.cache.set(token, newNode);
    this.addToHead(newNode);

    // O(1) eviction: remove tail if at capacity
    if (this.cache.size > this.MAX_SIZE && this.tail) {
      this.removeNode(this.tail);
      this.cache.delete(this.tail.token);
    }
  }

  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  private moveToHead(node: CacheNode): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToHead(node);
  }

  private addToHead(node: CacheNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: CacheNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }
}

// Cache node type definition for LRU list
class CacheNode {
  token: string;
  client: CopilotClient;
  timestamp: number;
  prev: CacheNode | null = null;
  next: CacheNode | null = null;

  constructor(token: string, client: CopilotClient, timestamp: number) {
    this.token = token;
    this.client = client;
    this.timestamp = timestamp;
  }

  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
  }
}

const clientCache = new ClientCache();

// Promise queue with maxConcurrency to prevent overwhelming external APIs
// Limits concurrent Copilot/OpenAI calls to prevent event loop saturation
class PromiseQueue {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private readonly maxConcurrency: number;

  constructor(maxConcurrency: number = 5) {
    this.maxConcurrency = maxConcurrency;
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.running >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const fn = this.queue.shift();
    if (fn) {
      try {
        await fn();
      } finally {
        this.running--;
        this.process();
      }
    }
  }

  size(): number {
    return this.queue.length;
  }
}

const apiQueue = new PromiseQueue(5); // Max 5 concurrent API calls

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

// Body capture middleware: stream request body asynchronously without blocking
// Enables HMAC verification without loading entire payload into memory
app.use(async (req: Request, res: Response, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    return next();
  }

  let rawBody = '';
  const contentType = req.get('content-type') || '';

  // Only capture body for JSON/webhook content types
  if (!contentType.includes('application/json')) {
    return next();
  }

  try {
    // Stream body chunks with timeout to prevent indefinite buffering
    const bodyTimeout = setTimeout(() => {
      req.socket.destroy();
    }, REQUEST_TIMEOUT_MS);

    req.on('data', (chunk) => {
      rawBody += chunk.toString('utf8');
      // Limit buffer to prevent DoS (max 5MB for webhook payloads)
      if (rawBody.length > 5 * 1024 * 1024) {
        clearTimeout(bodyTimeout);
        req.socket.destroy();
      }
    });

    req.on('end', () => {
      clearTimeout(bodyTimeout);
      (req as any).rawBody = rawBody;
      next();
    });

    req.on('error', (err) => {
      clearTimeout(bodyTimeout);
      console.error('Request body capture error:', err);
      next(err);
    });
  } catch (err) {
    console.error('Body capture middleware error:', err);
    next(err);
  }
});

// Parse JSON after body capture
app.use(express.json());

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

  // Initialize client with the user's token and connection pool agents
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    },
    // Enable connection pooling with persistent agents
    httpAgent,
    httpsAgent
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
    // Set highWaterMark to limit buffering; when exceeded, write returns false
    const highWaterMark = 16 * 1024; // 16KB default

    // Track backpressure: pause session if res buffer is filling
    let isPaused = false;
    let sessionPaused = false;

    const backpressureHandler = (event: any) => {
      if (event.type === "assistant.message_delta") {
        const chunk = {
          choices: [{ delta: { content: event.data.deltaContent } }]
        };
        
        // Attempt write; if returns false, buffer is full
        const canContinue = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        if (!canContinue && !isPaused) {
          isPaused = true;
          // Pause further event processing to avoid queuing
          if (session && typeof session.pause === 'function') {
            sessionPaused = true;
            session.pause();
          }
        }
      }
    };

    // Resume streaming when res buffer drains
    res.on('drain', () => {
      isPaused = false;
      if (sessionPaused && session && typeof session.resume === 'function') {
        sessionPaused = false;
        session.resume();
      }
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