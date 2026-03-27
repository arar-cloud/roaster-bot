import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string | undefined;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;
// LRU cache for Copilot sessions: Map(key -> { session, timestamp })
const sessionCache = new Map<string, { session: any; timestamp: number }>();
const MAX_CACHE_SIZE = 10;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Initialize rate limiter once at module scope (not per-request)
const webhookRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.headers['x-webhook-bypass'] === process.env.BYPASS_TOKEN,
  handler: (req: Request, res: Response) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

function getCachedOrCreateSession(sessionKey: string, creator: () => any): any {
  if (!sessionKey) {
    throw new Error('Session key is required');
  }
  const now = Date.now();
  const cached = sessionCache.get(sessionKey);

  if (cached && cached.session && now - cached.timestamp < CACHE_TTL) {
    return cached.session;
  }

  // Evict expired session if it exists
  if (cached) {
    sessionCache.delete(sessionKey);
  }

  // Create new session and cache it
  const session = creator();

  // Lazy cleanup: only prune expired sessions if cache exceeds max size
  if (sessionCache.size >= MAX_CACHE_SIZE) {
    const expiredKeys: string[] = [];
    for (const [key, value] of sessionCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        expiredKeys.push(key);
      }
    }
    // If expired keys found, delete them; otherwise fall back to LRU eviction
    if (expiredKeys.length > 0) {
      expiredKeys.forEach(key => sessionCache.delete(key));
    } else {
      let oldestKey = sessionKey;
      let oldestTime = now;
      for (const [key, value] of sessionCache.entries()) {
        if (value && value.timestamp < oldestTime) {
          oldestTime = value.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) {
        sessionCache.delete(oldestKey);
      }
    }
  }

  sessionCache.set(sessionKey, { session, timestamp: now });
  return session;
}



// Middleware to capture raw body BEFORE JSON parsing
app.use((req: Request, res: Response, next) => {
  if (req.path === '/agent') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      req.rawBody = data;
      next();
    });
  } else {
    next();
  }
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf instanceof Buffer ? buf.toString('utf8') : buf;
  }
}));

// Periodic cache cleanup: remove expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessionCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      sessionCache.delete(key);
    }
  }
  console.log(`[Cache cleanup] Removed expired entries. Current cache size: ${sessionCache.size}`);
}, 5 * 60 * 1000);

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

app.post('/webhook', webhookRateLimiter, async (req: Request, res: Response) => {
  // Early exit on client disconnect to free resources
  if (req.socket.destroyed) {
    return;
  }

  req.on('close', () => {
    if (!res.headersSent) {
      console.log('Request cancelled by client');
    }
  });

  // Webhook signature verification
  try {
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const rawBody = req.rawBody;

    // Defensive checks for missing/malformed signature components
    if (!signature || !rawBody || !webhookSecret) {
      if (webhookSecret) {
        // Only reject if secret is configured but signature is missing
        console.warn('Webhook validation: missing signature, body, or secret');
        return res.status(400).send('Missing webhook signature or body.');
      }
      // If no secret configured, allow request through
    } else {
      // Store rawBody reference once to avoid redundant string conversions
      const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
      const hmac = crypto.createHmac('sha256', webhookSecret);
      const digest = 'sha256=' + hmac.update(bodyBuffer).digest('hex');
      const expectedSignature = `sha256=${digest}`;

      // Use timing-safe comparison to prevent timing attacks
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return res.status(401).send('Unauthorized');
      }
    }
  } catch (error) {
    console.error('Webhook verification error:', error);
    return res.status(401).send('Unauthorized');
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

    let body;
    try {
      body = req.body;
    } catch (parseError) {
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const { messages } = body;
    
    // Validate messages array is present and not empty
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required and must not be empty' });
    }
    
    const userMessages = messages;
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Use cache-aware session retrieval with unique key per request context
    const sessionKey = `copilot-session-${process.env.GITHUB_APP_ID || 'default'}`;
    const sessionCreator = async () => await client.createSession({
      model: "gpt-4o",
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: systemPrompt
      }
    });

    const session = await getCachedOrCreateSession(sessionKey, sessionCreator);
    
    if (!session) {
      return res.status(503).json({ error: 'Service unavailable' });
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

    try {
      await session.sendAndWait({ prompt });
    } catch (sessionError) {
      console.error('Copilot session error:', sessionError instanceof Error ? sessionError.message : 'Unknown');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate completion' });
      }
      return;
    } finally {
      session.end();
    }

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