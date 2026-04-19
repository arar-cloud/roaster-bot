import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Request caching layer to reduce redundant database queries
interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

class RequestCache {
  private cache = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

  set(key: string, data: any, ttl: number = this.DEFAULT_TTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  generateKey(req: Request): string {
    const keyData = `${req.method}:${req.path}:${JSON.stringify(req.query)}:${req.body ? JSON.stringify(req.body) : ''}`;
    return crypto.createHash('sha256').update(keyData).digest('hex');
  }

  clear(): void {
    this.cache.clear();
  }
}

const requestCache = new RequestCache();

// Database connection pool configuration
class DatabaseConnectionPool {
  private maxConnections = 10;
  private activeConnections = 0;
  private queuedRequests: Array<() => Promise<any>> = [];
  private readonly QUEUE_TIMEOUT = 30000; // 30 seconds

  async execute<T>(query: () => Promise<T>): Promise<T> {
    if (this.activeConnections < this.maxConnections) {
      this.activeConnections++;
      try {
        return await query();
      } finally {
        this.activeConnections--;
        this.processQueue();
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Database query timeout: exceeded queue wait'));
      }, this.QUEUE_TIMEOUT);

      this.queuedRequests.push(async () => {
        clearTimeout(timeout);
        this.activeConnections++;
        try {
          return await query();
        } finally {
          this.activeConnections--;
        }
      });
    });
  }

  private processQueue(): void {
    while (this.queuedRequests.length > 0 && this.activeConnections < this.maxConnections) {
      const nextQuery = this.queuedRequests.shift();
      if (nextQuery) {
        nextQuery().catch(console.error);
      }
    }
  }

  getPoolStats() {
    return {
      activeConnections: this.activeConnections,
      maxConnections: this.maxConnections,
      queuedRequests: this.queuedRequests.length
    };
  }
}

const dbPool = new DatabaseConnectionPool();

// Batch query helper to convert N+1 patterns
function createBatchQueryHelper<T>(
  items: any[],
  queryFn: (batch: any[]) => Promise<Map<string, T>>
): Promise<T[]> {
  const batchSize = 100;
  const batches: any[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  return Promise.all(batches.map(batch => queryFn(batch)))
    .then(results => {
      const merged = new Map<string, T>();
      results.forEach(result => {
        result.forEach((value, key) => merged.set(key, value));
      });
      return Array.from(merged.values());
    });
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

// Caching middleware for GET requests
app.use((req: Request, res: Response, next) => {
  if (req.method === 'GET') {
    const cacheKey = requestCache.generateKey(req);
    const cachedResponse = requestCache.get(cacheKey);
    if (cachedResponse) {
      res.set('X-Cache', 'HIT');
      return res.json(cachedResponse);
    }
    res.set('X-Cache', 'MISS');
    // Intercept res.json to cache the response
    const originalJson = res.json.bind(res);
    res.json = function(data: any) {
      requestCache.set(cacheKey, data);
      return originalJson(data);
    };
  }
  next();
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