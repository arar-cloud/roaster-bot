import 'dotenv/config';
import express, onse } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
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

// Security headers
app.use((req: Request, res: Response, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
  limit: '10kb' // Prevent payload bomb attacks
}));

// Input validation middleware
app.use((req: Request, Response, next) => {
  if (req.method === 'POST' && req.path === '/webhook') {
    // Validate webhook event structure
    const event = req.get('x-github-event');
    if (!event || typeof event !== 'string' || event.length > 50) {
      return res.status(400).send('Invalid webhook event header');
    }
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).send('Invalid JSON payload');
    }
  }
  next();
});

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
  // Webhook signature verification using HMAC-SHA256
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!signature) {
    return res.status(401).json({ error: 'Unauthorized: Missing signature' });
  }

  if (!webhookSecret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'Missing raw body' });
  }

  const hash = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expected = `sha256=${hash}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return res.status(401).send('Invalid X-GitHub-Token format or length.');
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return res.status(401).send('Invalid X-GitHub-Token: contains forbidden characters.');

  // Validate token format (prevent injection)
  const tokenPattern = /^[a-zA-Z0-9_.-]+$/;
  if (!tokenPattern.test(token)) {
    return res.status(400).send('Invalid token format.');
  }

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
    let prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Validate and sanitize prompt parameter
    if (typeof prompt !== 'string') return res.status(400).send('Prompt must be a string.');
    if (prompt.length > 10000) return res.status(400).send('Prompt exceeds maximum length of 10000 characters.');
    if (prompt.trim().length === 0) return res.status(400).send('Prompt cannot be empty or whitespace only.');

    // Create session following SDK docs with validation
    let session;
    try {
      session = await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
      if (!session || typeof session !== 'object') throw new Error('Invalid session object returned from createSession');
    } catch (err) {
      console.error('Session creation failed:', err instanceof Error ? err.message : String(err));
      return res.status(500).send('Failed to initialize session.');
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
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  } finally {
    await client.stop();
  }
});

const roastLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
});

app.post('/roast', roastLimiter, async (req: Request, res: Response) => {
  // Validate authentication token
  const authHeader = req.headers.authorization as string;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    return;
  }
  const expectedToken = process.env.API_TOKEN || '';
  const token = authHeader.slice(7);
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
    return;
  }
  // Sanitize and validate input
  let { code } = req.body;
  if (typeof code !== 'string' || code.length === 0 || code.length > 50000) {
    res.status(400).json({ error: 'Bad request: Invalid code parameter' });
    return;
  }
  code = code.trim();

  // Prevent code injection and eval attacks
  const dangerousPatterns = /[`$(){}|&;><]/;
  if (dangerousPatterns.test(code)) {
    res.status(400).json({ error: 'Bad request: Code contains dangerous characters' });
    return;
  }

  res.json({ message: 'Code received and validated', length: code.length });
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});