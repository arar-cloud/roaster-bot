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
    interface Request {
      rawBody?: string;
      githubToken?: string;
      clientId?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Security event logger for audit trail
const logSecurityEvent = (eventType: string, details: Record<string, any>) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    eventType,
    ...details,
  };
  console.log(`[SECURITY_AUDIT] ${JSON.stringify(logEntry)}`);
};

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
    const clientId = (req as any).clientId || 'unknown';
    
    // Validate Content-Type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      logSecurityEvent('INPUT_VALIDATION_FAILURE', {
        reason: 'invalid_content_type',
        contentType: contentType || 'missing',
        clientId
      });
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }

    // Validate request body structure
    const body = req.body;
    if (!body || typeof body !== 'object') {
      logSecurityEvent('INPUT_VALIDATION_FAILURE', {
        reason: 'invalid_body_structure',
        clientId
      });
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Validate userMessages array
    if (!Array.isArray(body.userMessages)) {
      logSecurityEvent('INPUT_VALIDATION_FAILURE', {
        reason: 'messages_not_array',
        clientId
      });
      return res.status(400).json({ error: 'userMessages must be an array' });
    }

    // Validate message schema and length
    const MAX_MESSAGE_LENGTH = 2000;
    const MAX_MESSAGES = 50;
    if (body.userMessages.length > MAX_MESSAGES) {
      logSecurityEvent('INPUT_VALIDATION_FAILURE', {
        reason: 'too_many_messages',
        count: body.userMessages.length,
        max: MAX_MESSAGES,
        clientId
      });
      return res.status(400).json({ error: `Maximum ${MAX_MESSAGES} messages allowed` });
    }

    for (const msg of body.userMessages) {
      if (!msg || typeof msg !== 'object') {
        logSecurityEvent('INPUT_VALIDATION_FAILURE', {
          reason: 'invalid_message_structure',
          clientId
        });
        return res.status(400).json({ error: 'Each message must be an object' });
      }
      if (typeof msg.content !== 'string' || msg.content.length > MAX_MESSAGE_LENGTH) {
        logSecurityEvent('INPUT_VALIDATION_FAILURE', {
          reason: 'invalid_message_content',
          contentLength: msg.content?.length || 0,
          max: MAX_MESSAGE_LENGTH,
          clientId
        });
        return res.status(400).json({ error: `Message content must be string and under ${MAX_MESSAGE_LENGTH} chars` });
      }
      if (!['user', 'assistant', 'system'].includes(msg.role)) {
        logSecurityEvent('INPUT_VALIDATION_FAILURE', {
          reason: 'invalid_message_role',
          role: msg.role,
          clientId
        });
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

  // GitHub token extraction and validation middleware
  const clientId = crypto.randomBytes(8).toString('hex');
  const token = req.get('X-GitHub-Token');

  if (!token) {
    logSecurityEvent('AUTH_FAILURE', {
      reason: 'missing_token',
      clientId
    });
    return res.status(401).send('Missing X-GitHub-Token.');
  }

  if (typeof token !== 'string') {
    logSecurityEvent('AUTH_FAILURE', {
      reason: 'invalid_token_type',
      tokenType: typeof token,
      clientId
    });
    return res.status(400).send('Invalid token format');
  }

  // Basic token format validation: GitHub tokens typically start with 'ghp_' or 'ghu_'
  if (!token.match(/^(ghp_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+$/)) {
    logSecurityEvent('AUTH_FAILURE', {
      reason: 'invalid_token_format',
      clientId
    });
    return res.status(400).send('Invalid token format');
  }

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      logSecurityEvent('WEBHOOK_VERIFICATION_FAILURE', {
        reason: 'missing_raw_body',
        clientId
      });
      return res.status(400).send('Missing raw body.');
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
    try {
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(digest)
      );

      if (!isValid) {
        logSecurityEvent('WEBHOOK_SIGNATURE_MISMATCH', {
          ip: req.ip,
          path: req.path,
          clientId
        });
        return res.status(401).send('Webhook signature mismatch');
      }
    } catch (err) {
      logSecurityEvent('WEBHOOK_VERIFICATION_FAILURE', {
        reason: 'signature_comparison_error',
        error: (err as Error).message,
        clientId
      });
      return res.status(401).send('Webhook signature verification failed');
    }
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

// Global error handler middleware for uncaught exceptions and security logging
app.use((err: any, req: Request, res: Response, next: any) => {
  const clientId = (req as any).clientId || 'unknown';
  const errorMessage = err?.message || 'Unknown error';
  const stack = err?.stack || '';

  // Log full error details internally for security monitoring
  logSecurityEvent('UNHANDLED_ERROR', {
    message: errorMessage,
    path: req.path,
    method: req.method,
    clientId,
    stack: stack.substring(0, 500) // Limit stack trace in logs
  });

  // Sanitize error response to prevent sensitive data leakage
  const sanitizedError = errorMessage
    .replace(/token/gi, '[REDACTED]')
    .replace(/secret/gi, '[REDACTED]')
    .replace(/key/gi, '[REDACTED]')
    .replace(/password/gi, '[REDACTED]')
    .substring(0, 200);

  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});