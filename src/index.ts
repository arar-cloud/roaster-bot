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
    (req.body as any)[key] = JSON.parse(JSON.stringify((req.body as any)[key])
  }
}


const app = express();
const port = process.env.PORT || 3000;

// Middleware to capture raw body for webhook signature verification
app.use(express.json({
  verify: (req: any, res: any, buf: Buffer) => {
    req.rawBody = buf.toString('utf-8');
  }
}));

// Initialize GitHub Copilot Client
const copilotClient = new CopilotClient({
  token: process.env.GITHUB_TOKEN || '',
});

// Input validation middleware
app.use((req: Request, res: Response, next) => {
  if (req.method === 'POST' && req.body) {
    // Validate payload structure
    if (typeof req.body === 'object' && req.body !== null) {
      // Payload is valid
    } else {
      return res.status(400).json({ error: 'Invalid request body' });
    }
  }
  next();
});
if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is required. Aborting startup.');
}
const githubToken = process.env.GITHUB_TOKEN;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method !== 'POST'
});

const requestCache = new Map<string, { result: string; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(payload: string, timestamp?: string): string {
  // Sanitize cache key: use hash of payload to prevent cache poisoning via unsanitized keys
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return `webhook:${hash}:${timestamp || Date.now()}`;
}

function getCachedResult(key: string): string | null {
  const cached = requestCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }
  requestCache.delete(key);
  return null;
}

// Security headers middleware
app.use((req: Request, res: Response, next: any) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(limiter);

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

// Issue-416a5af43c: Verify webhook signature using SHA256 with timing-safe comparison
function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || signature.length === 0 || !secret) {
    return false;
  }
  const hmac = crypto.createHmac('sha256', secret);
  const expectedDigest = 'sha256=' + hmac.update(payload).digest('hex');
  // Use constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedDigest),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

// Issue-46163b3f16: Track processing to prevent race conditions in concurrent webhook handling
const processingWebhooks = new Set<string>();

app.post('/webhook', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!signature) {
    console.warn('Webhook rejected: missing signature header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  // Issue-416a5af43c: Use proper signature verification with SHA256
  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn('Webhook rejected: invalid signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  const client = new CopilotClient({
    token: githubToken
  });

  try {
    // Check deduplication cache for identical webhook payloads within 5-minute window
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const timestamp = req.headers['x-timestamp'] as string;
    const cacheKey = getCacheKey(rawBody, timestamp);

    // Issue-46163b3f16: Prevent race conditions by tracking concurrent processing
    if (processingWebhooks.has(cacheKey)) {
      console.warn('Webhook already processing, rejecting concurrent request');
      return res.status(202).json({ message: 'Webhook already processing' });
    }

    const cached = getCachedResult(cacheKey);
    if (cached) {
      res.json({ suggestion: cached, fromCache: true });
      return;
    }

    processingWebhooks.add(cacheKey);

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

    // Cache the response for deduplication
    if (res.statusCode === 200) {
      requestCache.set(cacheKey, { result: prompt, timestamp: Date.now() });
      // Cleanup old cache entries to prevent memory leaks
      for (const [key, value] of requestCache.entries()) {
        if (Date.now() - value.timestamp > CACHE_TTL) {
          requestCache.delete(key);
        }
      }
    }

    if (!prompt) {
      res.status(500).json({ error: 'No result available' });
      return;
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    console.error('Roast error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    await client.stop();
  }
});

  processingWebhooks.delete(cacheKey);
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});