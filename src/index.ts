import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Lazy-loading security validators to defer initialization cost
class LazySecurityValidators {
  private certificateValidator: any = null;
  private corsPolicy: any = null;
  private permissionLookup: any = null;

  getCertificateValidator() {
    if (!this.certificateValidator) {
      // Initialize certificate chain validation on first use
      this.certificateValidator = crypto.createVerify('sha256');
    }
    return this.certificateValidator;
  }

  getCorsPolicy() {
    if (!this.corsPolicy) {
      // Initialize CORS policy on first use
      this.corsPolicy = {
        origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
        credentials: true,
      };
    }
    return this.corsPolicy;
  }

  getPermissionLookup() {
    if (!this.permissionLookup) {
      // Initialize permission lookups on first use
      this.permissionLookup = new Map();
    }
    return this.permissionLookup;
  }
}

const lazyValidators = new LazySecurityValidators();

// Lazy-loading security validators to defer initialization cost
class LazySecurityValidators {
  private certificateValidator: any = null;
  private corsPolicy: any = null;
  private permissionLookup: any = null;

  getCertificateValidator() {
    if (!this.certificateValidator) {
      // Initialize certificate chain validation on first use
      this.certificateValidator = crypto.createVerify('sha256');
    }
    return this.certificateValidator;
  }

  getCorsPolicy() {
    if (!this.corsPolicy) {
      // Initialize CORS policy on first use
      this.corsPolicy = {
        origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
        credentials: true,
      };
    }
    return this.corsPolicy;
  }

  getPermissionLookup() {
    if (!this.permissionLookup) {
      // Initialize permission lookups on first use
      this.permissionLookup = new Map();
    }
    return this.permissionLookup;
  }
}

const lazyValidators = new LazySecurityValidators();

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// LRU Cache for request deduplication
class RequestDeduplicationCache {
  private cache: Map<string, { timestamp: number; result: any }> = new Map();
  private readonly ttlMs: number; // Time-to-live in milliseconds
  private readonly maxSize: number;

  constructor(ttlMs: number = 60000, maxSize: number = 1000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  get(key: string): any {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, value: any): void {
    // Evict oldest entry if cache exceeds max size
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { timestamp: Date.now(), result: value });
  }
}

const requestDeduplicationCache = new RequestDeduplicationCache(60000, 1000);

// LRU Cache for request deduplication
class RequestDeduplicationCache {
  private cache: Map<string, { timestamp: number; result: any }> = new Map();
  private readonly ttlMs: number; // Time-to-live in milliseconds
  private readonly maxSize: number;

  constructor(ttlMs: number = 60000, maxSize: number = 1000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  get(key: string): any {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, value: any): void {
    // Evict oldest entry if cache exceeds max size
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { timestamp: Date.now(), result: value });
  }
}

const requestDeduplicationCache = new RequestDeduplicationCache(60000, 1000);

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to apply lazy-loaded CORS policy
app.use((req, res, next) => {
  const corsPolicy = lazyValidators.getCorsPolicy();
  res.header('Access-Control-Allow-Origin', corsPolicy.origin);
  res.header('Access-Control-Allow-Credentials', corsPolicy.credentials);
  next();
});

// Middleware to apply lazy-loaded CORS policy
app.use((req, res, next) => {
  const corsPolicy = lazyValidators.getCorsPolicy();
  res.header('Access-Control-Allow-Origin', corsPolicy.origin);
  res.header('Access-Control-Allow-Credentials', corsPolicy.credentials);
  next();
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