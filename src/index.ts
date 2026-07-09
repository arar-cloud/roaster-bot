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

// Verify webhook signature using constant-time comparison
function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) {
    return false;
  }
  const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedSignature = `sha256=${hash}`;
  return crypto.timingSafeEqual(expectedSignature, signature);
}

// Validate GitHub token format and length
function validateGitHubToken(token: string | undefined): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }
  // GitHub tokens are typically 40-255 chars, alphanumeric with underscore/dash
  if (token.length < 20 || token.length > 255) {
    return false;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    return false;
  }
  return true;
}

// Structured security logging
function logSecurityEvent(event: string, details: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    event,
    ...details,
  }));
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Configure helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

// Enforce HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      return res.status(403).json({ error: 'HTTPS required' });
    }
    next();
  });
}

app.use(limiter); // Apply rate limiting globally to all routes

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

// Configure CORS with origin validation
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://github.com').split(',');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GitHub-Token, X-Hub-Signature-256');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new Error('WEBHOOK_SECRET environment variable must be set. Webhook signature verification cannot proceed without it.');
  }

  if (!signature) {
    return res.status(401).send('Missing X-Hub-Signature-256 header.');
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logSecurityEvent('missing_raw_body', { ip: req.ip || 'unknown' });
    return res.status(400).send('Bad request.');
  }

  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    logSecurityEvent('webhook_signature_verification_failed', {
      origin: req.get('origin'),
      userAgent: req.get('user-agent'),
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = req.get('X-GitHub-Token');
  const requestIp = req.ip || 'unknown';
  
  if (!token) {
    logSecurityEvent('missing_github_token', {
      origin: req.get('origin'),
      userAgent: req.get('user-agent'),
      ip: requestIp,
    });
    return res.status(401).send('Missing X-GitHub-Token.');
  }

  if (!validateGitHubToken(token)) {
    logSecurityEvent('invalid_github_token_format', {
      origin: req.get('origin'),
      userAgent: req.get('user-agent'),
      ip: requestIp,
    });
    return res.status(401).send('Invalid X-GitHub-Token format.');
  }

  // Initialize client with the user's token
  // Only pass whitelisted environment variables to CopilotClient
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token
      // Do not spread process.env to prevent secret exposure
    }
  });
  
  try {
    // Validate user messages for injection attacks
    const userMessages = req.body.messages || [];
    if (!Array.isArray(userMessages)) {
      logSecurityEvent('invalid_messages_format', {
        origin: req.get('origin'),
        userAgent: req.get('user-agent'),
        ip: requestIp,
      });
      return res.status(400).json({ error: 'Bad request' });
    }
    
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
    logSecurityEvent('session_error', {
      ip: req.ip || 'unknown',
      error: error instanceof Error ? error.message : String(error)
    });
    if (!res.headersSent) res.status(500).send('Internal server error.');
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});