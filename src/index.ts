import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { OpenAI } from 'openai';

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

// Validate required environment variables
if (!process.env.WEBHOOK_SECRET) {
  console.error('ERROR: WEBHOOK_SECRET environment variable is not set');
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  console.warn('WARNING: GITHUB_TOKEN environment variable is not set. Copilot integration will be disabled.');
}

// Middleware to capture raw body for webhook signature verification
app.use((req, res, next) => {
  let rawBody = '';
  req.on('data', chunk => {
    rawBody += chunk.toString('utf-8');
  });
  req.on('end', () => {
    req.rawBody = rawBody;
    next();
  });
});

// Enable security headers via Helmet
app.use(require('helmet')());

// Parse JSON request bodies
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Initialize Copilot client
let copilotClient: CopilotClient | null = null;
try {
  if (process.env.GITHUB_TOKEN) {
    copilotClient = new CopilotClient({ token: process.env.GITHUB_TOKEN });
  }
} catch (err) {
  console.warn('Warning: CopilotClient initialization failed', err);
}

// Enforce request size limit (5MB max to prevent memory exhaustion)
app.use(express.json({
  limit: '5mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Capture raw body for signature verification with size limit
app.use(express.raw({ type: 'application/json', limit: '5mb' }));

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

app.post('/webhook', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // SECURITY: Reject if secret is not configured
  if (!webhookSecret) {
    console.error('Error: GITHUB_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (!signature) {
    return res.status(401).send('Unauthorized');
  }

  const rawBody = req.rawBody;
  // Validate payload with size constraints
  if (!rawBody || typeof rawBody !== 'string' || rawBody.length === 0) {
    return res.status(400).send('Missing raw body.');
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  // SECURE: Using timingSafeEqual prevents timing attacks on webhook signature validation
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return res.status(403).send('Forbidden');
    }
  } catch {
    return res.status(403).send('Forbidden');
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).send('OpenAI API key not configured');
  }

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });

  try {
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
    } catch (webhookError) {
      console.error('Webhook processing error:', webhookError instanceof Error ? webhookError.message : String(webhookError));
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process webhook' });
      }
    } finally {
      await client.stop();
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});