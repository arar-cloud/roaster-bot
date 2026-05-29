import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
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

// Cache environment variables at startup to avoid repeated lookups
const webhookSecret = process.env.WEBHOOK_SECRET || '';
const port = parseInt(process.env.PORT || '3000', 10);

// Initialize CopilotClient singleton for connection pooling and reuse
let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient();
  }
  return copilotClient;
}

// Async HMAC validation to prevent event loop blocking
async function verifyWebhookSignature(signature: string, rawBody: string): Promise<boolean> {
  if (!webhookSecret || !signature) return false;
  const hmac = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expectedSignature = `sha256=${hmac}`;
  try {
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (err) {
    return false;
  }
}

// System prompt constant: pre-computed once, reused across all requests
const SYSTEM_PROMPT = `
  You are 'The Roaster' 🌶️💀.
  Your goal is to DESTROY the user's self-esteem by roasting their code.

  CORE DIRECTIVES:
  1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
  2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
  3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
`;

const app = express();

// Global error handler middleware for unhandled errors
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle unhandled promise rejections at process level
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Security and compression middleware
app.use(helmet()); // Apply security headers
app.use(compression({
  threshold: 512,
  level: 6
})); // Enable gzip/brotli compression with tuning for large responses

// Custom time-aware store for rate limiter to prevent memory leak
class TimeAwareStore {
  private store = new Map<string, { count: number; resetTime: number }>();
  private cleanupInterval: NodeJS.Timer;

  constructor() {
    // Clean up expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.store.entries()) {
        if (value.resetTime < now) {
          this.store.delete(key);
        }
      }
    }, 5 * 60 * 1000);
  }

  increment(key: string, windowMs: number): { totalHits: number; resetTime: number } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (entry && entry.resetTime > now) {
      entry.count++;
      return { totalHits: entry.count, resetTime: entry.resetTime };
    }

    const resetTime = now + windowMs;
    this.store.set(key, { count: 1, resetTime });
    return { totalHits: 1, resetTime };
  }

  resetKey(key: string): void {
    this.store.delete(key);
  }
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: new TimeAwareStore() as any,
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Serve static public directory with caching headers
app.use(express.static('public', {
  maxAge: '1d',
  etag: false
}));

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification with async crypto to prevent event loop blocking
  const signature = req.get('X-Hub-Signature-256');

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const isValid = await verifyWebhookSignature(signature, rawBody);
    if (!isValid) {
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
    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Create session following SDK docs
    const session = await client.createSession({
      model: "gpt-4o",
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: SYSTEM_PROMPT
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
  console.log(`🔥 Roaster server running on port ${port}`);
});