import dotenv from 'dotenv';
dotenv.config();
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
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }
    const trimmedToken = token.trim();
    if (trimmedToken.length === 0) {
      throw new Error('GITHUB_TOKEN cannot be empty after trimming');
    }
    // Validate token format (GitHub tokens typically start with ghp_)
    if (!trimmedToken.match(/^ghp_[a-zA-Z0-9_]{36,}$/)) {
      throw new Error('GITHUB_TOKEN format is invalid');
    }
    globalCopilotClient = new CopilotClient({
      token: trimmedToken,
    });
    consolee.log('Copilot client initialized successfully');
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

// Request signature validation middleware
function verifyRequestSignature(req: Request, res: Response, next: Function) {
  const signature = req.headers['x-signature'] as string;
  const signingSecret = process.env.REQUEST_SIGNING_SECRET;
  if (!signingSecret) {
    return next();
  }
  if (!signature) {
    return res.status(401).json({ error: 'Missing request signature' });
  }
  const bodyStr = JSON.stringify(req.body);
  const expectedSignature = crypto.createHmac('sha256', signingSecret).update(bodyStr).digest('hex');
  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid request signature' });
  }
  next();
}

// Security headers with helmet middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
}));

// Rate limiting FIRST (before body parsing to prevent bypass)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP',
  skip: (req) => req.method === 'GET'
});
app.use(limiter);

// Error handling wrapper for async endpoints
const asyncHandler = (fn: any) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  return Promise.resolve(fn(req, res, next)).catch(next);
};

// Apply rate limiter to webhook endpoint explicitly
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many webhook requests',
  keyGenerator: (req) => req.headers['x-github-signature-256'] as string || req.ip || 'unknown',
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

const port = process.env.PORT || 3000;

// Validate critical environment variables at startup
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

if (!process.env.GITHUB_WEBHOOK_SECRET) {
  throw new Error('GITHUB_WEBHOOK_SECRET environment variable is required');
}

app.use(express.json({
  limit: '10kb',
  verify: (req: any, res, buf) => {
    try {
      req.rawBody = buf.toString();
    } catch (err) {
      console.error('Raw body verification error:', err);
      throw new Error('Failed to process request body');
    }
  }
}));

app.use((req, res, next) => {
  if (req.method !== 'GET' && (!req.headers['content-type'] || !req.headers['content-type'].includes('application/json'))) {
    return res.status(400).json({ error: 'Content-Type must be application/json' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
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

// CORS configuration - restrict to trusted origins only
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.post('/roast', verifyRequestSignature, async (req: Request, res: Response) => {
  const { code } = req.body;
  // Input validation: non-empty, max 50KB, no suspicious patterns
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Code is required and must be a string' });
  }
  if (code.length > 51200) {
    return res.status(413).json({ error: 'Code payload too large (max 50KB)' });
  }
  // Prevent obvious code injection patterns
  if (/(exec|eval|spawn|fork|require\s*\()/.test(code)) {
    return res.status(400).json({ error: 'Dangerous patterns detected in input' });
  }
  try {
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
  if (!token || token.trim() === '') return res.status(401).send('Missing or invalid X-GitHub-Token.');

  // Input validation
  const userMessages = req.body.messages || [];
  if (!Array.isArray(userMessages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }
  for (const msg of userMessages) {
    if (typeof msg.content !== 'string' || msg.content.length > 5000) {
      return res.status(400).json({ error: 'Invalid message content' });
    }
  }

  // Initialize client with the user's token
  let client: CopilotClient | null = null;
  try {
    client = new CopilotClient({
      token: token.trim()
    });
  } catch (err) {
    console.error('Failed to initialize user Copilot client:', err);
    return res.status(500).send('Failed to initialize Copilot client.');
  }

  try {
    // Validate model parameter against allowlist
    const allowedModels = ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'gpt-4o'];
    const selectedModel = req.body.model && allowedModels.includes(req.body.model) ? req.body.model : 'gpt-4o';
    
    // Sanitize user message to prevent injection
    const sanitizedMessage = prompt.replace(/[\x00-\x1F\x7F]/g, '').trim();
    
    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.

      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content.trim().slice(0, 5000) : "Roast me.";

    // Create session following SDK docs with validated model
    const session = await client.createSession({
      model: selectedModel,
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: systemPrompt
      }
    });
    
    // Use sanitized message instead of raw prompt
    const safePrompt = sanitizedMessage;

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
  } catch (parseError) {
    console.error('Malformed webhook payload:', parseError);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Sanitize error response to prevent sensitive data leakage
    const isProduction = process.env.NODE_ENV === 'production';
    const errorResponse = isProduction ? { error: 'Request processing failed' } : { error: 'Invalid payload or processing failed' };
    res.status(400).json(errorResponse);
  }
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : (err.message || 'Unknown error');
  try {
    res.status(status).json({ error: message });
  } catch (serializationErr) {
    console.error('Response serialization failed:', serializationErr);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});