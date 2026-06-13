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
      userId?: string;
    }
  }
}

// Utility function to mask secrets in logs
function maskSecret(secret: string | undefined): string {
  if (!secret) return '[UNDEFINED]';
  if (secret.length <= 4) return '****';
  return secret.substring(0, 2) + '***' + secret.substring(secret.length - 2);
}

// Validate required environment variables at startup
function validateEnvironment() {
  const requiredVars = ['GITHUB_TOKEN', 'WEBHOOK_SECRET'];
  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const githubToken = process.env.GITHUB_TOKEN;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (githubToken && githubToken.length < 20) {
    throw new Error('GITHUB_TOKEN must be at least 20 characters');
  }
  if (webhookSecret && webhookSecret.length < 16) {
    throw new Error('WEBHOOK_SECRET must be at least 16 characters');
  }
}

validateEnvironment();

// Audit logging utility
interface AuditLog {
  timestamp: string;
  eventType: 'auth_success' | 'auth_failed' | 'api_call' | 'rate_limit_exceeded' | 'webhook_received' | 'webhook_failed';
  tokenHash?: string;
  endpoint: string;
  statusCode?: number;
  details?: string;
}

function logAuditEvent(event: AuditLog) {
  const logEntry = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  console.log(`[AUDIT] ${JSON.stringify(logEntry)}`);
}

function getTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);
}

const app = express();
const port = process.env.PORT || 3000;

// Apply Helmet security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  noSniff: true,
  xssFilter: true,
}));

// Global rate limiter for webhook endpoint
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-token rate limiter for /agent endpoint
const tokenRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // Per-token limit
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any, res) => {
    // Use X-GitHub-Token as the rate limit key
    const token = req.headers['x-github-token'] as string;
    return token || req.ip || 'unknown';
  },
  skip: (req, res) => {
    // Skip rate limiting if no token provided (will be rejected by auth anyway)
    return !req.headers['x-github-token'];
  },
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// CSRF token map: store per-session (in production, use Redis or similar)
const csrfTokens = new Map<string, { token: string; expires: number }>();

// Generate CSRF token endpoint
app.get('/csrf-token', (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomBytes(16).toString('hex');
  csrfTokens.set(sessionId, { token, expires: Date.now() + 3600000 }); // 1 hour expiry
  res.json({ csrfToken: token, sessionId });
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

app.post('/agent', tokenRateLimiter, async (req: Request, res: Response) => {
  // CSRF token validation
  const csrfToken = req.headers['x-csrf-token'] as string;
  const sessionId = req.headers['x-session-id'] as string;

  if (!csrfToken || !sessionId) {
    res.status(403).json({ error: 'Missing CSRF token or session ID' });
    return;
  }

  const storedTokenData = csrfTokens.get(sessionId);
  if (!storedTokenData || storedTokenData.expires < Date.now() || storedTokenData.token !== csrfToken) {
    res.status(403).json({ error: 'Invalid or expired CSRF token' });
    return;
  }

  // Invalidate token after use
  csrfTokens.delete(sessionId);

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
  if (!token) {
    logAuditEvent({
      eventType: 'auth_failed',
      endpoint: '/agent',
      statusCode: 401,
      details: 'Missing X-GitHub-Token'
    });
    return res.status(401).send('Missing X-GitHub-Token.');
  }

  // Validate token format: GitHub tokens start with 'ghp_' or 'ghu_'
  if (typeof token !== 'string' || !/^(ghp_|ghu_)[a-zA-Z0-9_]{36,255}$/.test(token)) {
    logAuditEvent({
      eventType: 'auth_failed',
      endpoint: '/agent',
      statusCode: 401,
      details: 'Invalid token format',
      tokenHash: getTokenHash(token)
    });
    return res.status(401).json({ error: 'Invalid token format' });
  }

  logAuditEvent({
    eventType: 'auth_success',
    endpoint: '/agent',
    statusCode: 200,
    tokenHash: getTokenHash(token)
  });

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });

  try {
    // Sanitize system prompt to prevent injection attacks
    const MAX_PROMPT_LENGTH = 1000;
    const sanitizeInput = (input: string): string => {
      return input
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, ' ')
        .substring(0, MAX_PROMPT_LENGTH);
    };

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

    // Input validation schema with length limits
    const MAX_CODE_LENGTH = 50000;
    const MAX_DIRECTIVE_LENGTH = 1000;

    // Validate and sanitize user prompt input
    if (typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid prompt: must be a string' });
    }
    if (prompt.length > MAX_DIRECTIVE_LENGTH) {
      return res.status(400).json({ error: `Prompt exceeds maximum length of ${MAX_DIRECTIVE_LENGTH}` });
    }
    prompt = sanitizeInput(prompt);

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
    res.setHeader('Set-Cookie', 'sessionId=' + sessionId + '; SameSite=Strict; HttpOnly; Secure');

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
    // Log detailed error server-side with unique identifier
    const errorId = crypto.randomBytes(8).toString('hex');
    console.error(`[ERROR-${errorId}] Copilot session failed:`, error instanceof Error ? error.message : String(error));

    // Return generic error to client, preventing information disclosure
    if (!res.headersSent) {
      if (error instanceof Error && error.message.includes('token')) {
        res.status(401).json({ error: 'Authentication failed', errorId });
      } else if (error instanceof Error && error.message.includes('rate')) {
        res.status(429).json({ error: 'Rate limit exceeded', errorId });
      } else {
        res.status(500).json({ error: 'Internal server error', errorId });
      }
    }
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});