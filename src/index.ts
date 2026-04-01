import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

let globalCopilotClient: CopilotClient | null = null;
let initError: Error | null = null;

function initializeCopilotClient() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token || token.trim() === '') {
      throw new Error('GITHUB_TOKEN environment variable is required and cannot be empty');
    }
    globalCopilotClient = new CopilotClient({
      token: token.trim(),
    });
    console.log('Copilot client initialized successfully');
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    console.error('Failed to initialize Copilot client:', initError);
  }
}

initializeCopilotClient();

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();

// Rate limiting FIRST (before body parsing to prevent bypass)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP'
});
app.use(limiter);
app.use(express.json({
  limit: '10kb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Apply rate limiter to webhook endpoint explicitly
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many webhook requests',
});

// Capture raw body for webhook verification before parsing
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => {
    data += chunk;
  });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'https:'],
    },
  },
}));
const port = process.env.PORT || 3000;

// Validate critical environment variables
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

// Validate required environment variables
const requiredEnvVars = ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

app.use(express.json({
  limit: '10kb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use((req, res, next) => {
  if (req.method !== 'GET' && (!req.headers['content-type'] || !req.headers['content-type'].includes('application/json'))) {
    return res.status(400).json({ error: 'Content-Type must be application/json' });
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

app.post('/agent', limiter, webhookLimiter, async (req: Request, res: Response) => {
  if (!globalCopilotClient || initError) {
    const status = initError ? 503 : 500;
    const message = initError ? 'Service temporarily unavailable' : 'Copilot client not initialized';
    console.error(`Webhook rejected: ${message}`);
    res.status(status).json({ error: message });
    return;
  }

  // Webhook signature verification with HMAC-SHA256 and constant-time comparison
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('WEBHOOK_SECRET not configured; webhook verification disabled');
    return res.status(400).send('WEBHOOK_SECRET not configured');
  }

  if (!signature) {
    console.warn('No webhook signature provided');
    return res.status(401).send('Missing X-Hub-Signature-256');
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  if (!webhookSecret.trim()) {
    console.warn('Webhook signature verification skipped: WEBHOOK_SECRET empty');
    return res.status(401).send('Invalid configuration');
  }

  const hmac = crypto.createHmac('sha256', webhookSecret.trim());
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      console.warn('Invalid webhook signature received');
      return res.status(401).send('Invalid signature');
    }
  } catch (err) {
    console.warn('Signature comparison failed:', err);
    return res.status(401).send('Invalid signature');
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  let client: CopilotClient | null = null;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (err) {
    console.error('Failed to initialize user Copilot client:', err);
    return res.status(500).send('Failed to initialize Copilot client.');
  }

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

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
  });
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});