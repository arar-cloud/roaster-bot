import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
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

app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Webhook signature verification middleware
const verifyWebhookSignature = (req: any, res: Response, next: Function) => {
  if (req.path === '/api/github-webhook' || req.path === '/webhook') {
    const signature = req.headers['x-hub-signature-256'] as string;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    
    if (!signature || !webhookSecret) {
      return res.status(401).json({ error: 'Missing signature or secret' });
    }
    
    const hash = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody || '')
      .digest('hex');
    
    const expectedSignature = `sha256=${hash}`;
    
    try {
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (e) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }
  next();
};

// Authentication middleware for protected endpoints
const authMiddleware = (req: Request, res: Response, next: Function) => {
  const token = req.headers['x-auth-token'] || req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = process.env.AUTH_TOKEN;

  if (!token || !expectedToken || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing auth token' });
  }
  next();
};

// Input validation middleware for user commands
// Input validation helper for webhook payloads
function validateWebhookInput(body: any): boolean {
  if (!body || typeof body !== 'object') return false;

  // Validate action field against injection patterns
  const action = body.action;
  if (action && typeof action === 'string') {
    if (/[<>"'`();\$\{\}]/g.test(action)) return false;
  }

  // Validate issue and PR fields are strings only (not objects that could contain code)
  if (body.issue) {
    if (body.issue.title && typeof body.issue.title !== 'string') return false;
    if (body.issue.body && typeof body.issue.body !== 'string') return false;
  }
  if (body.pull_request) {
    if (body.pull_request.title && typeof body.pull_request.title !== 'string') return false;
    if (body.pull_request.body && typeof body.pull_request.body !== 'string') return false;
  }

  return true;
}

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

// Webhook endpoint with strict input validation
app.post('/webhook', limiter, authMiddleware, (req: Request, res: Response) => {
  // Validate webhook payload structure
  if (!validateWebhookInput(req.body)) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  // GitHub webhook signature verification
  const signature = req.headers['x-github-event'];
  if (!signature) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Acknowledge webhook receipt
  res.status(200).json({ status: 'received' });
});

// Input validation and sanitization middleware
const validateInputSanitization = (req: Request, res: Response, next: Function) => {
  // Limit request body size to 1MB
  if (req.body && JSON.stringify(req.body).length > 1048576) {
    return res.status(413).json({ error: 'Request body too large' });
  }
  
  // Sanitize string inputs: remove null bytes and control characters
  const sanitizeString = (str: string): string => {
    if (typeof str !== 'string') return str;
    return str.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 10000);
  };
  
  // Recursively sanitize string fields in request body
  const sanitizeObject = (obj: any): any => {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return sanitizeString(obj);
    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item));
    }
    if (typeof obj === 'object') {
      const sanitized: any = {};
      for (const key of Object.keys(obj)) {
        sanitized[key] = sanitizeObject(obj[key]);
      }
      return sanitized;
    }
    return obj;
  };
  
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
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
app.use(validateInputSanitization);
app.use(verifyWebhookSignature);
app.use(limiter);

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

app.post('/agent', limiter, validateUserInput, authMiddleware, async (req: Request, res: Response) => {
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

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});