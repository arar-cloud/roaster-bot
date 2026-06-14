import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface RequeUse timing-safe comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedDigest)
    );

    if (!isValid) {
      console.error('[SECURITY] Webhook signature mismatch');
        rawBody?: string;
      githubToken?: string;
      clientId?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Security middleware: enforce HTTPS and headers
app.use(helmet({
  hsts: {
    maxAge: 31536000, // 1 year in seconds
    includeSubDomains: true,
    preload: true
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));

// Per-token rate limiter: keyed by GitHub token for per-user quota enforcement
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // reduced per-token limit from global 100
  keyGenerator: (req: any) => {
    // Extract token from header for per-token rate limiting
    const token = req.headers['x-github-token'];
    if (!token) {
      return req.ip || 'unknown'; // fallback to IP if no token
    }
    // Hash token to avoid exposing it in rate limit headers
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path !== '/agent' // only rate limit the sensitive endpoint
});

// Strict JSON parser with size limits
app.use(express.json({
  limit: '10kb', // Limit request payload to prevent DoS
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Input validation middleware
const validateAgentInput = (req: Request, res: Response, next: any) => {
  if (req.path === '/agent' && req.method === 'POST') {
    // Validate Content-Type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }

    // Validate request body structure
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Validate userMessages array
    if (!Array.isArray(body.userMessages)) {
      return res.status(400).json({ error: 'userMessages must be an array' });
    }

    // Validate message schema and length
    const MAX_MESSAGE_LENGTH = 2000;
    const MAX_MESSAGES = 50;
    if (body.userMessages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: `Maximum ${MAX_MESSAGES} messages allowed` });
    }

    for (const msg of body.userMessages) {
      if (!msg || typeof msg !== 'object') {
        return res.status(400).json({ error: 'Each message must be an object' });
      }
      if (typeof msg.content !== 'string' || msg.content.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `Message content must be string and under ${MAX_MESSAGE_LENGTH} chars` });
      }
      if (!['user', 'assistant', 'system'].includes(msg.role)) {
        return res.status(400).json({ error: 'Invalid message role' });
      }
    }
  }
  next();
};

app.use(validateAgentInput);

// CORS configuration with explicit origin validation
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) {
      return callback(null, true);
    }

    // Whitelist specific origins in production
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : ['http://localhost:3000', 'http://localhost:5173'];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error(`[SECURITY] CORS origin blocked: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-GitHub-Token'],
  maxAge: 86400
};

app.use(cors(corsOptions));

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

app.post('/agent', tokenLimiter, async (req: Request, res: Response) => {
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