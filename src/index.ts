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

// Apply security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  xssFilter: true,
  noSniff: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Sanitize user messages to prevent prompt injection attacks
function sanitizeMessage(message: any): string {
  if (typeof message !== 'string') {
    throw new Error('Message must be a string');
  }
  
  const MAX_MESSAGE_LENGTH = 4096;
  
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('Message exceeds maximum length');
  }
  
  // Remove null bytes and control characters that could be used for injection
  const sanitized = message
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
  
  if (sanitized.length === 0) {
    throw new Error('Message cannot be empty after sanitization');
  }
  
  return sanitized;
}

app.use(express.json({
  limit: '1mb', // Prevent memory exhaustion from oversized payloads
  verify: (req, res, buf) => {
    (req as any).rawBody = buf.toString();
  }
}));

// Apply rate limiting globally to all routes
app.use(limiter);

// Middleware to validate token header length
app.use((req, res, next) => {
  const token = req.headers['x-github-token'] as string;
  if (token && token.length > 255) {
    res.status(400).send('Token header exceeds maximum length');
    return;
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

app.post('/agent', async (req: Request, res: Response) => {
  // Webhook signature verification - MANDATORY for security
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('WEBHOOK_SECRET environment variable is required');
    return res.status(500).send('Server configuration error');
  }

  if (!signature) {
    return res.status(401).send('Missing X-Hub-Signature-256 header');
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return res.status(401).send('Unauthorized');
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Validate GitHub token format and length
  const GITHUB_TOKEN_MAX_LENGTH = 255;
  const GITHUB_TOKEN_PATTERN = /^(gh[pousr]{1}_[A-Za-z0-9_]{36,255}|[A-Za-z0-9_]{40})$/;

  if (token.length > GITHUB_TOKEN_MAX_LENGTH) {
    return res.status(400).send('GitHub token exceeds maximum length');
  }

  if (!GITHUB_TOKEN_PATTERN.test(token)) {
    return res.status(400).send('GitHub token format is invalid');
  }

  // Validate that the token is not empty after format check
  if (!token.trim()) {
    return res.status(400).send('GitHub token cannot be empty');
  }

  // Initialize client with the user's token
  // Create CopilotClient with only the required token parameter
  // Do NOT use spread operator (...process.env) as it exposes all environment variables
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token
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
    const prompt = lastMessage ? sanitizeMessage(lastMessage.content) : "Roast me.";

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
    // Log error securely without exposing sensitive information
    console.error('CopilotClient error:', error instanceof Error ? error.message : 'Unknown error');
    
    // Send sanitized error response to client
    const errorMessage = error instanceof Error && error.message.includes('token')
      ? 'Authentication failed'
      : 'The roaster overheated.';
    
    if (!res.headersSent) {
      res.status(500).json({
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    }
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});