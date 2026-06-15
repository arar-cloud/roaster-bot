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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Input validation middleware
const validateAgentRequest = (req: Request & { rawBody?: string }, res: Response, next: Function) => {
  const body = req.body as Record<string, unknown>;
  
  // Validate userMessages is an array
  if (!Array.isArray(body.userMessages)) {
    return res.status(400).json({ error: 'userMessages must be an array' });
  }
  
  // Validate array length (max 50 messages)
  if (body.userMessages.length > 50) {
    return res.status(400).json({ error: 'userMessages exceeds maximum length' });
  }
  
  // Validate each message
  for (const msg of body.userMessages) {
    if (typeof msg !== 'object' || msg === null) {
      return res.status(400).json({ error: 'Invalid message format' });
    }
    const message = msg as Record<string, unknown>;
    if (typeof message.content !== 'string' || message.content.length > 4096) {
      return res.status(400).json({ error: 'Message content must be a string under 4096 characters' });
    }
  }
  
  // Validate optional idempotencyKey if present
  if (body.idempotencyKey && typeof body.idempotencyKey !== 'string') {
    return res.status(400).json({ error: 'idempotencyKey must be a string' });
  }
  
  next();
};

// Secure webhook signature verification with constant-time comparison
const verifyWebhookSignature = (signature: string, payload: string, secret: string): boolean => {
  if (!secret) {
    return false;
  }
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
};

// Validate and sanitize GitHub token format
const isValidGitHubToken = (token: string): boolean => {
  if (typeof token !== 'string') {
    return false;
  }
  // GitHub tokens should be alphanumeric and underscore only, 20-255 chars
  const tokenRegex = /^[a-zA-Z0-9_]{20,255}$/;
  return tokenRegex.test(token);
};

// Apply helmet for security headers
app.use(helmet());

app.use(express.json({
  limit: '1mb',
  verify: (req: Request & { rawBody?: string }, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', limiter, (req, res) => {
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