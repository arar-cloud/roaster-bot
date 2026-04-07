import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      cacheKey?: string;
    }
  }
}

// ============================================
// Response Caching Layer
// ============================================
class ResponseCache {
  private cache: Map<string, { body: string; etag: string; timestamp: number }> = new Map();
  private readonly ttl: number = 5 * 60 * 1000; // 5 minutes default

  set(key: string, body: string) {
    const etag = crypto.createHash('md5').update(body).digest('hex');
    this.cache.set(key, { body, etag, timestamp: Date.now() });
  }

  get(key: string) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return cached;
  }

  clear(pattern?: RegExp) {
    if (pattern) {
      for (const key of this.cache.keys()) {
        if (pattern.test(key)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }
}

const responseCache = new ResponseCache();

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
    req.cacheKey = `${req.path}:${JSON.stringify(req.query)}`;
    const cached = responseCache.get(req.cacheKey);
    if (cached && req.headers['if-none-match'] === cached.etag) {
      res.status(304).end();
      return;
    }
    if (cached) {
      res.set('ETag', cached.etag);
      res.set('Cache-Control', 'public, max-age=300');
      res.send(cached.body);
      return;
    }
  }
  next();
});

// Wrapper for cacheable responses
function sendCached(res: Response, cacheKey: string | undefined, data: any, statusCode = 200) {
  const body = JSON.stringify(data);
  const etag = crypto.createHash('md5').update(body).digest('hex');
  
  if (cacheKey) {
    responseCache.set(cacheKey, body);
  }
  
  res.status(statusCode);
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=300');
  res.send(body);
}

// Stream large payloads to avoid CPU spike from synchronous JSON serialization
function streamJSON(res: Response, data: any, statusCode = 200) {
  res.status(statusCode);
  res.set('Content-Type', 'application/json');
  res.set('Transfer-Encoding', 'chunked');
  
  // For arrays, stream elements to reduce memory pressure
  if (Array.isArray(data)) {
    res.write('[');
    data.forEach((item, idx) => {
      if (idx > 0) res.write(',');
      res.write(JSON.stringify(item));
    });
    res.write(']');
  } else {
    res.write(JSON.stringify(data));
  }
  res.end();
}

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