import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { createClient } from 'redis';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

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

// Initialize Redis client for distributed rate limiting (optional)
let redisClient: any = null;
if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.connect().catch(err => console.error('Redis connection failed:', err));
}

// Webhook verification middleware: validate signature before body parsing
const verifyWebhookSignature = (req: Request, res: Response, next: any) => {
  // Only verify POST /agent requests
  if (req.method !== 'POST' || !req.path.endsWith('/agent')) {
    return next();
  }

  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    // For webhook routes, verify before body parsing
    let rawBody = '';
    req.on('data', (chunk: Buffer) => {
      rawBody += chunk.toString();
      // Prevent buffer overflow DoS
      if (rawBody.length > 1048576) { // 1MB limit
        req.pause();
        res.status(413).send('Payload too large');
      }
    });
    req.on('end', () => {
      // Compute HMAC using streaming (non-blocking)
      const hmac = crypto.createHmac('sha256', webhookSecret);
      hmac.update(rawBody);
      const digest = 'sha256=' + hmac.digest('hex');

      // Constant-time comparison with length check
      const signatureBuf = Buffer.from(signature);
      const digestBuf = Buffer.from(digest);
      if (signatureBuf.length !== digestBuf.length) {
        return res.status(401).send('Unauthorized');
      }
      if (!crypto.timingSafeEqual(signatureBuf, digestBuf)) {
        return res.status(401).send('Unauthorized');
      }

      // Signature valid: attach rawBody and continue
      (req as any).rawBody = rawBody;
      next();
    });
  } else {
    next();
  }
};

// CopilotClient singleton with connection pooling
let copilotClientInstance: InstanceType<typeof CopilotClient> | null = null;
let sessionCache: any = null;
let sessionCacheExpiry = 0;
const SESSION_CACHE_TTL = 300000; // 5 minutes

function getCopilotClient(): InstanceType<typeof CopilotClient> {
  if (!copilotClientInstance) {
    copilotClientInstance = new CopilotClient({
      token: process.env.GITHUB_TOKEN || '',
      // Explicit connection keep-alive for connection pooling
      keepAlive: true,
    });
  }
  return copilotClientInstance;
}

function getCachedSession() {
  const now = Date.now();
  if (sessionCache && sessionCacheExpiry > now) {
    return sessionCache;
  }
  return null;
}

function setCachedSession(session: any) {
  sessionCache = session;
  sessionCacheExpiry = Date.now() + SESSION_CACHE_TTL;
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware chain ordered for performance:
// 1. Helmet: early security headers and validation
app.use(helmet());

// 2. Webhook signature verification: fail-fast before JSON parsing
app.use(verifyWebhookSignature);

// 3. Rate limiting: protect after authentication
app.use(limiter);

// 4. JSON parsing: only on valid, rate-limited requests
app.use(express.json({
  limit: '1mb',
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

app.post('/agent', async (req: Request, res: Response) => {
  // Webhook signature verification already done in middleware
  // rawBody is attached to request if signature was valid

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Reuse singleton client instance instead of creating new instance per request
  const client = getCopilotClient();

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

    // Attempt to reuse cached session for connection pooling; create new if expired
    let session = getCachedSession();
    if (!session) {
      session = await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
      setCachedSession(session);
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