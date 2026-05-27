import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
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

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute sliding window for faster recovery
  limit: 30, // Lower per-window limit with shorter window = smoother token bucket
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed requests (4xx, 5xx) to reduce false rejections
  skipFailedRequests: false,
  keyGenerator: (req: Request) => {
    // Use X-GitHub-Token for authenticated endpoints to prevent single user token hoarding
    const token = req.get('X-GitHub-Token');
    return token ? `token:${token}` : req.ip || 'unknown';
  },
  handler: (req: Request, res: Response) => {
    // Graceful rate limit response with retry-after header
    res.set('Retry-After', '60');
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: 60,
    });
  },
});

let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient({
      token: process.env.GITHUB_TOKEN || '',
    });
  }
  return copilotClient;
}

const cachedHTML = `
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `;

// Pre-computed environment config to avoid spreading process.env on every request
const envConfig = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  PORT: process.env.PORT,
};

// Constant-time HMAC verification to prevent timing attacks and event loop blocking
function verifyWebhookSignature(signature: string, rawBody: string, secret: string): boolean {
  if (!signature || !rawBody || !secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const expectedDigest = Buffer.from('sha256=' + hmac.update(rawBody).digest('hex'));
  const providedDigest = Buffer.from(signature);
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

// Factory function to create CopilotClient with custom token without global state mutation
function createCopilotClient(token: string): CopilotClient {
  return new CopilotClient({
    token: token,
  });
}

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', limiter, (req, res) => {
  res.send(cachedHTML);
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = envConfig.GITHUB_WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      if (!verifyWebhookSignature(signature, rawBody, webhookSecret)) {
        return res.status(401).send('Unauthorized');
      }
    } catch (error) {
      console.error('Signature verification error:', error);
      return res.status(401).send('Unauthorized');
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Create client with user's token without mutating global state
  const client = createCopilotClient(token);
  
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

// Global error handler - must be last middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).send({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});