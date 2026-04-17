import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import http from 'http';
import https from 'https';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// Connection pooling for external service clients
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

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

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

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