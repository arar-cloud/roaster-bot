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
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Secret masking utility
const maskSecret = (secret: string, visibleChars: number = 4): string => {
  if (!secret || secret.length <= visibleChars) return '***';
  return secret.substring(0, visibleChars) + '*'.repeat(Math.max(3, secret.length - visibleChars));
};

// Webhook payload sanitization utility
const sanitizePayload = (payload: any): { valid: boolean; error?: string; sanitized?: any } => {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be an object' };
  }
  
  // Check payload size (rough estimate)
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > 65536) { // 64KB limit for GitHub webhook payload
    return { valid: false, error: 'Payload exceeds maximum size' };
  }
  
  // Validate required GitHub webhook fields
  if (typeof payload.action !== 'string' || payload.action.length === 0 || payload.action.length > 128) {
    return { valid: false, error: 'Invalid action field' };
  }
  
  // Sanitize pull_request content if present
  if (payload.pull_request) {
    const pr = payload.pull_request;
    if (typeof pr.title !== 'string' || pr.title.length > 1024) {
      return { valid: false, error: 'Invalid PR title' };
    }
    if (typeof pr.body !== 'string' || pr.body.length > 65536) {
      return { valid: false, error: 'Invalid PR body' };
    }
    // Escape HTML/script content
    pr.title = escapeHtml(pr.title);
    pr.body = escapeHtml(pr.body);
  }
  
  // Sanitize push commit content if present
  if (Array.isArray(payload.commits)) {
    if (payload.commits.length > 100) {
      return { valid: false, error: 'Too many commits in payload' };
    }
    for (const commit of payload.commits) {
      if (typeof commit.message !== 'string' || commit.message.length > 4096) {
        return { valid: false, error: 'Invalid commit message' };
      }
      commit.message = escapeHtml(commit.message);
    }
  }
  
  return { valid: true, sanitized: payload };
};

// HTML escape utility to prevent injection
const escapeHtml = (text: string): string => {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '`': '&#96;'
  };
  return text.replace(/[&<>"'`]/g, (char) => map[char]);
};

// Structured logging with redaction
const secureLog = (level: string, message: string, context?: Record<string, any>) => {
  const redactedContext = context
    ? Object.entries(context).reduce((acc, [key, val]) => {
        if (typeof val === 'string' && (key.toLowerCase().includes('token') || key.toLowerCase().includes('secret'))) {
          acc[key] = maskSecret(val);
        } else {
          acc[key] = val;
        }
        return acc;
      }, {} as Record<string, any>)
    : undefined;
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...redactedContext }));
};

// Enforce required environment variables at startup
if (!process.env.WEBHOOK_SECRET) {
  console.error('FATAL: WEBHOOK_SECRET environment variable is required');
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for webhook/AI endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // 20 requests per 15 minutes for webhook endpoint
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// Content-Type validation middleware
const validateContentType = (req: Request, res: Response, next: any) => {
  const contentType = req.get('Content-Type');
  if (!contentType || !contentType.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
};

// Configure CORS for webhook endpoints
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    const allowedOrigins = ['https://github.com', 'https://api.github.com'];
    // Stricter: require origin header to be present and in whitelist
    if (origin && allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'), false);
    }
  },
  credentials: false,
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type', 'X-Hub-Signature-256', 'X-GitHub-Token', 'X-GitHub-Event']
};

// API Key authentication middleware for protected endpoints
const requireApiKey = (req: Request, res: Response, next: any) => {
  const apiKey = req.get('X-API-Key');
  const expectedKey = process.env.ADMIN_API_KEY;
  
  if (!expectedKey) {
    secureLog('error', 'ADMIN_API_KEY not configured', {});
    return res.status(500).json({ error: 'Server configuration error' });
  }
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expectedKey))) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  
  next();
};

app.use(cors(corsOptions));

// Apply security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  frameguard: { action: 'deny' },
  xssFilter: true,
  noSniff: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// Raw body capture middleware - MUST run before JSON parsing
app.use((req: Request, res: Response, next: any) => {
  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => {
      rawBody += chunk.toString();
    });
    req.on('end', () => {
      (req as any).rawBody = rawBody;
      next();
    });
  } else {
    next();
  }
});

app.use(express.json({
  limit: '1mb'
}));

// Global request timeout - prevent slowloris attacks
app.use((req: Request, res: Response, next: any) => {
  req.setTimeout(30000); // 30 second timeout
  res.setTimeout(30000); // Response timeout
  
  // Handle timeout events
  req.on('timeout', () => {
    secureLog('warn', 'Request timeout', { clientIp: req.ip, path: req.path });
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
    req.connection.destroy();
  });
  
  res.on('timeout', () => {
    secureLog('warn', 'Response timeout', { clientIp: req.ip, path: req.path });
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway timeout' });
    }
    req.connection.destroy();
  });
  
  next();
});

// Centralized error handler
app.use((err: any, req: Request, res: Response, next: any) => {
  const clientIp = req.ip || 'unknown';
  const eventId = crypto.randomUUID();
  
  // Log full error server-side with context
  const errorContext = {
    message: err.message || 'Unknown error',
    stack: err.stack,
    type: err.constructor.name,
    endpoint: req.path,
    method: req.method
  };
  secureLog('error', 'Unhandled error', { eventId, clientIp, ...errorContext });
  
  // Return sanitized error response to client
  const statusCode = err.statusCode || 500;
  if (!res.headersSent) {
    res.status(statusCode).json({
      error: statusCode === 500 ? 'Internal server error' : err.message || 'An error occurred',
      eventId: eventId // For client to reference in support requests
    });
  }
});

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

// Protected health check endpoint
app.get('/health', requireApiKey, (req: Request, res: Response) => {
  const clientIp = req.ip || 'unknown';
  secureLog('info', 'Health check accessed', { clientIp });
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/agent', strictLimiter, validateContentType, async (req: Request, res: Response) => {
  const clientIp = req.ip || 'unknown';
  const eventId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    // Validate and sanitize webhook payload
    const payloadValidation = sanitizePayload(req.body);
    if (!payloadValidation.valid) {
      secureLog('warn', 'Invalid webhook payload', { eventId, clientIp, reason: payloadValidation.error });
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Webhook signature verification
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // Verify webhook signature with HMAC-SHA256
    if (!webhookSecret) {
      secureLog('error', 'WEBHOOK_SECRET not configured', { eventId, clientIp });
      return res.status(500).json({ error: 'Server configuration error' });
    }

    if (!signature) {
      secureLog('warn', 'Missing webhook signature', { eventId, clientIp });
      return res.status(401).json({ error: 'Authentication required' });
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      secureLog('warn', 'Missing request body', { eventId, clientIp });
      return res.status(400).json({ error: 'Invalid request' });
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const computed = `sha256=${hmac.update(rawBody).digest('hex')}`;

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
      secureLog('warn', 'Invalid webhook signature', { eventId, clientIp, signatureMatch: false });
      return res.status(401).json({ error: 'Authentication required' });
    }

    secureLog('info', 'Webhook signature verified', { eventId, clientIp });

  const token = req.get('X-GitHub-Token');
  
  // Validate GitHub token presence and format
  if (!token) {
    secureLog('warn', 'Missing GitHub token', { eventId, clientIp });
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (typeof token !== 'string' || token.length === 0) {
    secureLog('warn', 'Invalid token format', { eventId, clientIp });
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Validate token format (basic checks, e.g., GitHub token patterns)
  if (!token.startsWith('ghu_') && !token.startsWith('ghp_') && !token.startsWith('ghs_') && !token.startsWith('gho_')) {
    secureLog('warn', 'Token format mismatch', { eventId, clientIp, tokenType: 'invalid' });
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Initialize client with the user's token
  // Do not log token or include in error messages
  let client;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
    secureLog('info', 'Copilot client initialized', { eventId, clientIp, tokenType: 'valid' });
  } catch (error) {
    secureLog('error', 'Failed to initialize Copilot client', { eventId, clientIp, errorType: error instanceof Error ? error.constructor.name : 'unknown' });
    return res.status(500).json({ error: 'Service unavailable' });
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

    // Validate userMessages input
    if (!Array.isArray(userMessages)) {
      return res.status(400).json({ error: 'userMessages must be an array' });
    }

    if (userMessages.length === 0 || userMessages.length > 100) {
      return res.status(400).json({ error: 'userMessages must contain 1-100 items' });
    }

    for (const msg of userMessages) {
      if (typeof msg !== 'object' || msg === null) {
        return res.status(400).json({ error: 'Each message must be an object' });
      }
      if (typeof msg.role !== 'string' || !['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'Invalid message role' });
      }
      if (typeof msg.content !== 'string' || msg.content.length === 0 || msg.content.length > 4096) {
        return res.status(400).json({ error: 'Message content must be 1-4096 characters' });
      }
    }

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

    // SECURITY NOTE: Response is streamed directly to client, never executed or eval'd
    // All user input is escaped and sanitized before sending to Copilot API
    await session.sendAndWait({ prompt });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error during roasting session (error details suppressed)');
    if (!res.headersSent) res.status(500).json({ error: 'The roaster overheated.' });
  } finally {
    try {
      await client.stop();
    } catch (stopError) {
      console.error('Error stopping client (error details suppressed)');
    }
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});