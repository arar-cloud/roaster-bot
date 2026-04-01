import dotenv from 'dotenv';
dotenv.config();

const requiredEnvVars = ['OPENAI_API_KEY', 'PORT'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { body, query, validationResult } from 'express-validator';
import type { NextFunction } from 'express';
import { CopilotClient } from '@github/copilot-sdk';

const asyncHandler = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch((err: Error) => { next(err); }); };

// Extend Express Request type for security validation
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      isGithubVerified?: boolean;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  skip: (req: Request) => !req.isGithubVerified
});

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: true,
  dnsPrefetchControl: true,
  frameguard: true,
  hidePoweredBy: true,
  hsts: true,
  ieNoOpen: true,
  noSniff: true,
  referrerPolicy: true,
  xssFilter: true
}));

// Validate required environment variables
const requiredEnvVars = ['GITHUB_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'GITHUB_TOKEN'];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Initialize CopilotClient singleton at module level with error handling
let copilotClient: CopilotClient;
try {
  copilotClient = new CopilotClient({
    token: process.env.GITHUB_TOKEN!,
  });
} catch (error) {
  console.error('Failed to initialize CopilotClient:', error);
  process.exit(1);
}



app.use(express.json({
  limit: '10kb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ limit: '10kb', extended: false }));

app.use(limiter);

// Input validation middleware
const validateInput = (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.body && typeof req.body === 'object') {
      for (const [key, value] of Object.entries(req.body)) {
        if (typeof value === 'string' && value.length > 10000) {
          return res.status(400).json({ error: 'Input payload too large' });
        }
      }
    }
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid request format' });
  }
};

app.use(validateInput);

// Global error handler for synchronous and unhandled errors
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

app.get('/health', (req, res) => {
  try {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ status: 'error' });
  }
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

app.post('/roast', body('message').trim().isLength({ min: 1, max: 1000 }).escape(), (req: Request, res: Response, next: NextFunction) => { const errors = validationResult(req); if (!errors.isEmpty()) { return res.status(400).json({ errors: errors.array() }); } next(); }, asyncHandler(async (req: Request, res: Response) => {
  // Roast endpoint implementation
  res.json({ roast: 'Your code needs validation!' });
}));

app.post('/webhook', (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  if (!signature) {
    return res.status(403).json({ error: 'Missing signature' });
  }

  const body = req.rawBody;
  if (!body) {
    return res.status(400).json({ error: 'Missing request body' });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
    return res.status(403).json({ error: 'Invalid signature' });
  }
  console.log('Received webhook');
  res.status(200).json({ status: 'ok' });
});

app.post('/agent', body('messages').optional().isArray(), asyncHandler(async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from('sha256=' + digest))) {
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Reuse singleton copilotClient, override token in session
  const sessionClient = copilotClient;

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
    const session = await sessionClient.createSession({
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
    await sessionClient.stop();
  }
}));

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});