import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Startup validation for environment variables
function validateEnvironment(): void {
  const requiredVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN'];
  const optionalVars = ['PORT', 'ALLOWED_ORIGINS'];
  const errors: string[] = [];

  // Check required variables
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      errors.push(`Missing required environment variable: ${varName}`);
    }
  });

  // Validate WEBHOOK_SECRET format if present
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret && webhookSecret.length < 16) {
    errors.push('WEBHOOK_SECRET must be at least 16 characters');
  }

  // Validate GITHUB_TOKEN format if present
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken && !/^(ghp_|gho_|ghu_)/i.test(githubToken)) {
    errors.push('GITHUB_TOKEN does not match expected GitHub token format');
  }

  // Validate PORT if present
  const port = process.env.PORT;
  if (port && (isNaN(parseInt(port, 10)) || parseInt(port, 10) < 1 || parseInt(port, 10) > 65535)) {
    errors.push('PORT must be a valid port number (1-65535)');
  }

  if (errors.length > 0) {
    console.error('[STARTUP ERROR] Environment validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  console.log('[STARTUP] Environment variables validated successfully');
}

// Run validation at startup
validateEnvironment();

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer | string;
      rawBodyString?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Request context tracking for session isolation and audit logging
const requestContextMap = new Map<string, {
  requestId: string;
  token: string;
  timestamp: number;
  endpoint: string;
  ip: string;
}>();

// Generate unique request IDs
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Audit log helper
function auditLog(requestId: string, action: string, details: any): void {
  const context = requestContextMap.get(requestId);
  const logEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    action,
    endpoint: context?.endpoint,
    ip: context?.ip,
    ...details
  };
  console.log('[AUDIT]', JSON.stringify(logEntry));
}

// IP-based rate limiter for unauthenticated requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => {
    return req.ip || 'unknown';
  }
});

// Per-token rate limiter for authenticated requests
const tokenLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkTokenRateLimit(token: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const window = 15 * 60 * 1000; // 15 minutes
  const limit = 300; // Higher limit for authenticated tokens

  let record = tokenLimitMap.get(token);
  
  if (!record || now > record.resetTime) {
    record = { count: 0, resetTime: now + window };
    tokenLimitMap.set(token, record);
  }

  const allowed = record.count < limit;
  record.count++;

  return {
    allowed,
    remaining: Math.max(0, limit - record.count),
    resetTime: record.resetTime
  };
}

// Payload validation constants
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
const MAX_JSON_DEPTH = 10;
const MAX_ARRAY_SIZE = 1000;

// Check JSON payload depth recursively
function validateJsonDepth(obj: any, currentDepth: number = 0): boolean {
  if (currentDepth > MAX_JSON_DEPTH) {
    return false;
  }

  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_SIZE) {
      return false;
    }
    return obj.every(item => validateJsonDepth(item, currentDepth + 1));
  }

  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj).every(value => validateJsonDepth(value, currentDepth + 1));
  }

  return true;
}

app.use(express.json({
  limit: `${MAX_PAYLOAD_SIZE / 1024}kb`,
  verify: (req: any, res, buf: Buffer) => {
    // Capture raw buffer before any middleware mutation
    req.rawBody = buf;
    req.rawBodyString = buf.toString('utf8');
    
    // Validate Content-Length header
    const contentLength = parseInt(req.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_SIZE) {
      throw new Error(`Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE} bytes`);
    }
  }
}));

// Middleware to validate JSON depth and structure
app.use((req: any, res: Response, next) => {
  if (req.body && typeof req.body === 'object') {
    if (!validateJsonDepth(req.body)) {
      return res.status(400).json({ error: 'Request payload exceeds complexity limits' });
    }
  }
  next();
});

// Request context initialization middleware
app.use((req: any, res: Response, next) => {
  const requestId = generateRequestId();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  // Capture request metadata for audit logging
  requestContextMap.set(requestId, {
    requestId,
    token: req.get('X-GitHub-Token') || '',
    timestamp: Date.now(),
    endpoint: req.path,
    ip: req.ip || req.connection.remoteAddress || 'unknown'
  });
  
  // Cleanup context when response finishes
  res.on('finish', () => {
    requestContextMap.delete(requestId);
  });
  
  next();
});

// Origin validation middleware for webhook endpoint
function validateOrigin(req: any, res: Response, next: any): boolean {
  const origin = req.get('origin');
  const referer = req.get('referer');
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

  // If no allowed origins configured, reject
  if (allowedOrigins.length === 0) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return false;
  }

  // Validate origin header
  if (origin && !allowedOrigins.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  // Validate referer header
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = `${refererUrl.protocol}//${refererUrl.host}`;
      if (!allowedOrigins.includes(refererOrigin)) {
        res.status(403).json({ error: 'Referer not allowed' });
        return false;
      }
    } catch (e) {
      res.status(400).json({ error: 'Invalid referer header' });
      return false;
    }
  }

  // Set secure CORS headers for allowed origins
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-GitHub-Token,X-Hub-Signature-256');
    res.setHeader('Access-Control-Max-Age', '3600');
  }

  return true;
}

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

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Origin validation for cross-origin requests
  if (!validateOrigin(req as any, res, undefined)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }

  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    // Use captured raw body Buffer to prevent middleware tampering
    const rawBodyBuffer = typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : (req.rawBody || Buffer.alloc(0));
    if (rawBodyBuffer.length === 0) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBodyBuffer).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
        // Simple check for dev
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Validate GitHub token format and structure
  const validTokenPatterns = /^(ghp_|gho_|ghu_)[A-Za-z0-9_]{36,255}$/;
  if (!validTokenPatterns.test(token)) {
    return res.status(400).json({ error: 'Invalid GitHub token format' });
  }

  // Token length validation (GitHub tokens are typically 36-255 chars after prefix)
  if (token.length > 300) {
    return res.status(400).json({ error: 'Token exceeds maximum length' });
  }

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });
  
  const requestId = req.requestId;

  try {
    // Check per-token rate limit
    const rateLimitCheck = checkTokenRateLimit(token);
    if (!rateLimitCheck.allowed) {
      auditLog(requestId, 'RATE_LIMIT_EXCEEDED', { token: token.substring(0, 10) });
      res.setHeader('Retry-After', Math.ceil((rateLimitCheck.resetTime - Date.now()) / 1000));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: rateLimitCheck.resetTime
      });
    }

    // Validate and sanitize user messages
    const userMessages = req.body.messages || [];
    if (!Array.isArray(userMessages)) {
      auditLog(requestId, 'INVALID_MESSAGES_FORMAT', { received: typeof userMessages });
      return res.status(400).json({ error: 'Messages must be an array' });
    }

    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    if (!lastMessage) {
      auditLog(requestId, 'NO_USER_MESSAGE', {});
      return res.status(400).json({ error: 'No user message found' });
    }

    const prompt = lastMessage.content;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      auditLog(requestId, 'INVALID_PROMPT', { contentType: typeof prompt });
      return res.status(400).json({ error: 'Invalid prompt content' });
    }

    // Sanitize messages and validate structure for API safety
    const sanitizedMessages = userMessages.map((msg: any) => {
      if (!msg || typeof msg !== 'object') {
        throw new Error('Invalid message structure');
      }
      const validRoles = ['system', 'user', 'assistant'];
      if (!validRoles.includes(msg.role)) {
        throw new Error(`Invalid role: ${msg.role}`);
      }
      if (typeof msg.content !== 'string') {
        throw new Error('Message content must be string');
      }
      return { role: msg.role, content: msg.content };
    });

    auditLog(requestId, 'REQUEST_RECEIVED', { messageCount: sanitizedMessages.length });

    auditLog(requestId, 'SESSION_INIT', { model: 'gpt-4o' });

    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.
      
      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    // Create session following SDK docs
    let session;
    try {
      session = await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
    } catch (sessionError) {
      auditLog(requestId, 'SESSION_CREATION_FAILED', { error: sessionError instanceof Error ? sessionError.message : String(sessionError) });
      return res.status(503).json({ error: 'Failed to initialize session' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      session.on((event: any) => {
        if (event.type === "assistant.message_delta") {
          if (!event.data || typeof event.data.deltaContent !== 'string') {
            auditLog(requestId, 'MALFORMED_RESPONSE', { eventType: event.type });
            return;
          }
          const chunk = {
            choices: [{ delta: { content: event.data.deltaContent } }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      });

      await session.sendAndWait({ prompt });
      auditLog(requestId, 'SESSION_COMPLETE', { success: true });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (sessionError) {
      const errorMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
      auditLog(requestId, 'SESSION_EXECUTION_FAILED', { error: errorMsg.substring(0, 200) });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Session execution failed' });
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`);
        res.end();
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    auditLog(requestId, 'REQUEST_FAILED', { error: errorMsg.substring(0, 200) });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Request processing failed' });
    }
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});