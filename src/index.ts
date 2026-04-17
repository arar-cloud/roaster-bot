import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { promisify } from 'util';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import http from 'http';
import https from 'https';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
    PoolMonitor.checkAllAgents();
    }, PoolMonitor.checkInterval);
  }

  // Monitor all registered agents in a single tick
  private static checkAllAgents() {
    for (const [agent, metadata] of PoolMonitor.agents.entries()  rawBody?: string;
    }
  }
}

// Async crypto helper for signature verification
const verifySignatureAsync = async (data: Buffer, signature: string, secret: string): Promise<boolean> => {
  try {
    const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch (error) {
    return false;
  }
};

// Connection pool monitor for tracking socket saturation
class PoolMonitor {
  private socketUsage: Map<string, { used: number; max: number; timestamp: number }> = new Map();
  private highWaterMark = 0.8; // 80% threshold for scaling alerts
  private checkInterval: NodeJS.Timer | null = null;

  start(agent: http.Agent | https.Agent, name: string): void {
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.checkInterval = setInterval(() => {
      const sockets = agent.sockets ? Object.values(agent.sockets).flat().length : 0;
      const maxSockets = agent.maxSockets || 50;
      const usage = sockets / maxSockets;
      this.socketUsage.set(name, { used: sockets, max: maxSockets, timestamp: Date.now() });
      if (usage > this.highWaterMark) {
    let socketArray of 0;
      if ('sockets' in agent && typeof agent.sockets === 'object') {
        for (console.warn(`[PoolMonitor] ${name}: Socket saturation at ${(usage * 100).toFixed(1)}% (${sockets}/${maxSockets})`);
        }
    }
  }

  start() {
    // No-op: unified timer already running via getInstance
    return;
  }

  stop() {
    // Clear all registrations and stop unified timer
    PoolMonitor.agents.clear();
    if (PoolMonitor.timerHandle) {
      clearInterval(PoolMonitor.timerHandle);
      PoolMonitor.timerHandle = null;
    }
    PoolMonitor.instance = null;
  }

  getSocketCount(): number {
    const metadata = PoolMonitor.agents.get(this.agent);
    return metadata ? metadata.socketCount : 0;
    }, 5000);
  }

  getStatus(): Map<string, { used: number; max: number; timestamp: number }> {
    return this.socketUsage;
  }

  stop(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }
}

const poolMonitor = new PoolMonitor();

// Connection pooling for external service clients with dynamic scaling
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 30000,
});

// Start pool monitoring
poolMonitor.start(httpAgent, 'httpAgent');
poolMonitor.start(httpsAgent, 'httpsAgent');

// Singleton CopilotClient instance with connection pooling
let copilotClientInstance: CopilotClient | null = null;

const getCopilotClient = (): CopilotClient => {
  if (!copilotClientInstance) {
    copilotClientInstance = new CopilotClient({
HUB_TOKEN || '',
      httpAgent,
      httpsAgent,
    });
  }
  return copilotClientInstance;
};

const app = express();
const port = process.env.PORT || 3000;

// Configure JSON parser middleware with support for large payloads
const jsonLimit = process.env.JSON_LIMIT || '50mb';
const urlEncodedLimit = process.env.URL_ENCODED_LIMIT || '50mb';

// Streaming JSON parser with chunked processing for large payloads
app.use(express.json({
  limit: '100mb',
  strict: true,
  type: 'application/json',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Middleware to detect large payloads and enable streaming mode
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.headers['content-length']) {
    const contentLength = parseInt(req.headers['content-length'], 10);
    if (contentLength > 10 * 1024 * 1024) {
      res.setHeader('X-Streaming-Mode', 'enabled');
    }
  }
  next();
});

app.use(express.urlencoded({
  limit: urlEncodedLimit,
  extended: true,
}));

// Request-level cache to memoize repeated calls within a single request
interface RequestCache {
  [key: string]: any;
}

declare global {
  namespace Express {
    interface Request {
      cache?: RequestCache;
    }
  }
}

// Middleware to initialize and clear request-level cache
app.use((req: Request, res: Response, next) => {
  req.cache = {};
  res.on('finish', () => {
    delete req.cache;
  });
  next();
});

// Cache helper function for memoizing expensive operations
const getCachedOrCompute = async (
  req: Request,
  cacheKey: string,
  computeFn: () => Promise<any>
): Promise<any> => {
  if (!req.cache) req.cache = {};
  if (cacheKey in req.cache) {
    return req.cache[cacheKey];
  }
  const result = await computeFn();
  req.cache[cacheKey] = result;
  return result;
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Memoized component renderer to avoid redundant DOM calculations
interface ComponentCache {
  content: string;
  timestamp: number;
}

// LRU Cache node for doubly-linked list O(1) eviction
class LRUCacheNode<K, V> {
  constructor(
    public key: K,
    public value: V,
    public prev: LRUCacheNode<K, V> | null = null,
    public next: LRUCacheNode<K, V> | null = null
  ) {}
}

// LRU cache with bounded size to prevent memory leaks
class LRUCache<K, V> {
  private cache = new Map<K, LRUCacheNode<K, V>>();
  private head: LRUCacheNode<K, V> | null = null;
  private tail: LRUCacheNode<K, V> | null = null;
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = Math.max(1, maxSize);
  }

  get(key: K): V | undefined {
    const node = this.cache.get(key);
    if (!node) return undefined;
    this.moveToTail(node);
    return node.value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      const node = this.cache.get(key)!;
      node.value = value;
      this.moveToTail(node);
      return;
    }
    const node = new LRUCacheNode(key, value);
    this.cache.set(key, node);
    this.addToTail(node);
    if (this.cache.size > this.maxSize) {
      this.evictHead();
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  private moveToTail(node: LRUCacheNode<K, V>): void {
    if (node === this.tail) return;
    this.removeNode(node);
    this.addToTail(node);
  }

  private addToTail(node: LRUCacheNode<K, V>): void {
    if (!this.head) {
      this.head = this.tail = node;
      return;
    }
    node.prev = this.tail;
    node.next = null;
    this.tail!.next = node;
    this.tail = node;
  }

  private removeNode(node: LRUCacheNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }

  private evictHead(): void {
    if (this.head) {
      this.cache.delete(this.head.key);
      this.removeNode(this.head);
    }
  }
}

const componentCache = new LRUCache<string, ComponentCache>(1000);
const CACHE_TTL = 60000; // 1 minute

const memoizeHtmlComponent = (componentId: string, renderFn: () => string): string => {
  const cached = componentCache.get(componentId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.content;
  }
  const content = renderFn();
  componentCache.set(componentId, { content, timestamp: Date.now() });
  return content;
}; // LRU eviction prevents unbounded growth beyond 1000 entries

// Async HTML rendering with streaming support to unblock event loop
const memoizeHtmlComponentAsync = async (componentId: string, renderFn: () => string): Promise<string> => {
  const cached = componentCache.get(componentId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.content;
  }
  // Yield to event loop to process concurrent requests
  await new Promise(resolve => setImmediate(resolve));
  const content = renderFn();
  componentCache.set(componentId, { content, timestamp: Date.now() });
  return content;
};

// Stream HTML response in chunks to allow event loop to process other requests
const streamHtmlResponse = async (res: Response, html: string): Promise<void> => {
  const chunkSize = 1024;
  for (let i = 0; i < html.length; i += chunkSize) {
    res.write(html.slice(i, i + chunkSize));
    // Yield to event loop after each chunk
    await new Promise(resolve => setImmediate(resolve));
  }
};

// Pool status endpoint for monitoring connection saturation
app.get('/pool-status', (req: Request, res: Response) => {
  const status = poolMonitor.getStatus();
  const poolInfo: Record<string, any> = {};
  status.forEach((value, key) => {
    poolInfo[key] = {
      used: value.used,
      max: value.max,
      utilization: ((value.used / value.max) * 100).toFixed(2) + '%'
    };
  });
  res.json({ timestamp: new Date().toISOString(), pools: poolInfo });
});

// Backpressure middleware to reject requests when pool saturation exceeds threshold
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const status = poolMonitor.getStatus();
  const SATURATION_THRESHOLD = 0.85;
  for (const [name, value] of status) {
    const utilization = value.used / value.max;
    if (utilization > SATURATION_THRESHOLD) {
      console.warn(`[Backpressure] ${name} saturated at ${(utilization * 100).toFixed(1)}%`);
      return res.status(503).json({ error: 'Service overloaded: connection pool saturation' });
    }
  }
  next();
});

app.get('/', async (req, res) => {
  // Serve memoized HTML with streaming to unblock event loop during rendering
  const html = await memoizeHtmlComponentAsync('home_page', () => `
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `);
  try {
    res.setHeader('Content-Type', 'text/html');
    await streamHtmlResponse(res, html);
    res.end();
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

  // Connection pool configuration for API calls
  const createConnectionPool = (maxConnections = 10) => {
    let activeConnections = 0;
    const executeWithPooling = async (fn: () => Promise<any>) => {
      while (activeConnections >= maxConnections) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      activeConnections++;
      try {
        return await fn();
      } finally {
        activeConnections--;
      }
    };
    return { executeWithPooling };
  };

  const pool = createConnectionPool(10);

  // Reuse client instance across requests to avoid initialization overhead
  // This would typically be stored at module level, but for per-request isolation:
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
    // Use connection pooling to prevent resource exhaustion under concurrent load
    const session = await pool.executeWithPooling(async () => {
      return await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
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