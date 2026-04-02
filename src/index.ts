import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import helmet from 'helmet';

// Retry wrapper for external API calls with exponential backoff
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> => {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // exponential backoff: 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('Retries exhausted');
};

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

// Input validation middleware for user commands
const validateUserInput = (req: Request, res: Response, next: Function) => {
    const { code, messages } = req.body;

  // Validate content-type
  const contentType = req.get('Content-Type');
  if (contentType && !contentType.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }

  // Enforce payload size limits (1MB already set by express.json, but validate at logic level)
  const bodySize = JSON.stringify(req.body).length;
  if (bodySize > 1048576) {
    return res.status(413).json({ error: 'Request payload too large' });
  }

  // Validate code parameter if present
  if (code && typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid code parameter type' });
  }

  // Reject null bytes and dangerous control characters
  const dangerousPattern = /\0|[\x00-\x08\x0B\x0C\x0E-\x1F]/;
  if (code && dangerousPattern.test(code)) {
    return res.status(400).json({ error: 'Invalid characters detected in payload' });
  }

  // Validate messages array format if present
  if (messages && !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages must be an array' });
  }

  if (messages) {
    for (const msg of messages) {
      if (!msg.role || !msg.content || typeof msg.content !== 'string') {
        return res.status(400).json({ error: 'Invalid message format' });
      }
      if (dangerousPattern.test(msg.content)) {
        return res.status(400).json({ error: 'Invalid characters detected in message' });
      }
    }
  }

  next();
};

app.use(helmet());
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
  limit: '1mb'
}));
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

app.post('/agent', limiter, validateUserInput, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    // Validate required headers and payload
    if (typeof signature !== 'string') {
      return res.status(400).json({ error: 'Invalid signature header' });
    }

    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    try {
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token using retry logic
  const client = await retryWithBackoff(
    () => Promise.resolve(
      new CopilotClient({
        env: {
          GITHUB_TOKEN: token,
          ...process.env
        }
      })
    )
  );

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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Pragma', 'no-cache');

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
    // Don't expose internal error details to client
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    await client.stop();
  }
});

// Security headers for sensitive endpoints
app.use((req: Request, res: Response, next: Function) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// Test Copilot connection at startup with graceful fallback
let copilotReady = false;
try {
  if (process.env.COPILOT_TOKEN) {
    const testClient = new CopilotClient({ token: process.env.COPILOT_TOKEN });
    console.log('Copilot client initialized successfully');
    copilotReady = true;
  } else {
    console.warn('Warning: COPILOT_TOKEN not set. Copilot features disabled.');
  }
} catch (error) {
  console.error('Warning: Copilot client initialization failed. Running in degraded mode.');
  console.error(error instanceof Error ? error.message : String(error));
  copilotReady = false;
}

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});