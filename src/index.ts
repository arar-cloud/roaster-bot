import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import Ajv from 'ajv';
import { CopilotClient } from '@github/copilot-sdk';

// Request body cache for webhook verification only with size limit and TTL
const rawBodyCache = new Map<string, { body: string; timestamp: number }>();
const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 300000; // 5 minutes
let cacheCounter = 0;

function addToRawBodyCache(id: string, body: string): void {
  // Clean expired entries
  const now = Date.now();
  for (const [key, value] of rawBodyCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      rawBodyCache.delete(key);
    }
  }
  
  // Enforce size limit with LRU eviction
  if (rawBodyCache.size >= CACHE_MAX_SIZE) {
    const firstKey = rawBodyCache.keys().next().value;
    if (firstKey) rawBodyCache.delete(firstKey);
  }
  
  rawBodyCache.set(id, { body, timestamp: now });
}

function getRawBodyFromCache(id: string): string | null {
  const entry = rawBodyCache.get(id);
  if (!entry) return null;
  
  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL_MS) {
    rawBodyCache.delete(id);
    return null;
  }
  
  return entry.body;
}

// Token validation and rate limit tracking
const tokenFailureTracker = new Map<string, { count: number; firstAttempt: number }>();
const MAX_TOKEN_FAILURES = 10;
const TOKEN_FAILURE_WINDOW_MS = 3600000; // 1 hour

function isValidGitHubToken(token: string): boolean {
  // GitHub tokens typically start with ghp_, ghu_, or ghs_ and are base62-encoded
  if (!token || typeof token !== 'string') return false;
  return /^(ghp_|ghu_|ghs_)[A-Za-z0-9_]{36,255}$/.test(token);
}

function trackTokenFailure(token: string): boolean {
  const now = Date.now();
  const tracker = tokenFailureTracker.get(token);
  
  if (!tracker) {
    tokenFailureTracker.set(token, { count: 1, firstAttempt: now });
    return true;
  }
  
  if (now - tracker.firstAttempt > TOKEN_FAILURE_WINDOW_MS) {
    tokenFailureTracker.set(token, { count: 1, firstAttempt: now });
    return true;
  }
  
  tracker.count++;
  return tracker.count <= MAX_TOKEN_FAILURES;
}

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBodyId?: string;
    }
  }
}

// Sanitize and validate user input to prevent prompt injection
function sanitizeUserInput(input: string, maxLength: number = 2000): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  
  // Truncate to max length
  let sanitized = input.substring(0, maxLength);
  
  // Remove null bytes and control characters
  sanitized = sanitized.replace(/\x00/g, '').replace(/[\x01-\x08\x0B-\x0C\x0E-\x1F]/g, '');
  
  // Escape backticks and prompt delimiters to prevent injection
  sanitized = sanitized.replace(/`/g, '\\`').replace(/---/g, '\\-\\-\\-');
  
  return sanitized.trim();
}

function sanitizeOutput(output: string): string {
  if (!output || typeof output !== 'string') {
    return '';
  }
  
  // Remove null bytes and control characters
  let sanitized = output.replace(/\x00/g, '').replace(/[\x01-\x08\x0B-\x0C\x0E-\x1F]/g, '');
  
  // Truncate extremely long responses
  if (sanitized.length > 10000) {
    sanitized = sanitized.substring(0, 10000) + '... [truncated]';
  }
  
  return sanitized;
}

const app = express();
const port = process.env.PORT || 3000;

// Enforce required security configuration
if (!process.env.WEBHOOK_SECRET) {
  console.error('FATAL: WEBHOOK_SECRET environment variable is not set. Webhook authentication is disabled.');
  process.exit(1);
}

// Validate GITHUB_TOKEN at startup
if (!process.env.GITHUB_TOKEN) {
  console.error('FATAL: GITHUB_TOKEN environment variable is not set. LLM requests will fail.');
  process.exit(1);
}

// Apply security headers middleware
app.use(helmet());

// CORS and origin validation middleware
app.use((req, res, next) => {
  const origin = req.headers.origin as string;
  // Configure allowed origins from environment or restrict to same-origin
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GitHub-Token, X-Hub-Signature-256');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for sensitive /agent endpoint
const agentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Much stricter limit for authentication/LLM endpoint
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests to /agent endpoint, please try again later',
});

app.use(express.json({
  limit: '1mb', // Prevent memory exhaustion from oversized payloads
  verify: (req: any, res, buf) => {
    // Store rawBody in scoped cache with unique ID instead of on request object
    const bodyId = `body_${++cacheCounter}_${Date.now()}`;
    rawBodyCache.set(bodyId, buf.toString());
    req.rawBodyId = bodyId;
    // Clean up old cache entries to prevent memory leaks
    if (rawBodyCache.size > 100) {
      const firstKey = rawBodyCache.keys().next().value;
      rawBodyCache.delete(firstKey);
    }
  }
}));

// Request body schema validation middleware
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/agent') {
    const { userMessages } = req.body;
    if (!userMessages) {
      res.status(400).json({ error: 'Missing required field: userMessages' });
      return;
    }
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

app.post('/agent', agentLimiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const bodyId = (req as any).rawBodyId;
    const rawBody = bodyId ? rawBodyCache.get(bodyId) : undefined;
    if (!rawBody) return res.status(400).json({ error: 'Invalid request' });

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    // Constant-time comparison to prevent timing attacks
    let isValid = false;
    try {
      // Prevent timing attacks with constant-time comparison
      isValid = crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(digest));
    } catch (err) {
      // Length mismatch or invalid buffers - treat as failed verification
      isValid = false;
      console.warn('Webhook signature verification failed: buffer comparison error');
    }

    if (!isValid) {
      console.warn('Webhook signature verification failed: invalid signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Clean up rawBody cache after successful verification
    if (bodyId) rawBodyCache.delete(bodyId);
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');
  
  // Validate token format: GitHub tokens are typically alphanumeric with underscores/dashes
  // Classic tokens start with 'ghp_', OAuth tokens with 'gho_', etc.
  if (!/^[a-zA-Z0-9_-]{20,255}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  // Initialize client with the user's token and validate
  if (!isValidGitHubToken(token)) {
    return res.status(400).json({ error: 'Invalid token format or insufficient scope' });
  }
  
  let client: CopilotClient;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (initError) {
    console.error('CopilotClient initialization failed:', initError instanceof Error ? initError.message : 'Unknown error');
    return res.status(401).json({ error: 'Authentication failed: invalid token or insufficient scope' });
  }
  
  // Helper function to sanitize user input and prevent prompt injection
  const sanitizeUserInput = (input: string): string => {
    if (typeof input !== 'string') {
      throw new Error('Input must be a string');
    }
    // Remove null bytes and excessive whitespace
    return input.replace(/\x00/g, '').trim();
  };
  
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
    
    // Sanitize and validate user messages to prevent prompt injection
    if (!Array.isArray(userMessages)) {
      res.status(400).json({ error: 'userMessages must be an array' });
      return;
    }
    
    const maxMessageLength = 2000;
    const sanitizedMessages = userMessages.map((msg: any) => {
      if (typeof msg !== 'object' || msg === null) {
        throw new Error('Each user message must be an object');
      }
      if (typeof msg.content !== 'string') {
        throw new Error('Message content must be a string');
      }
      if (msg.content.length > maxMessageLength) {
        throw new Error(`Message exceeds maximum length of ${maxMessageLength} characters`);
      }
      // Remove null bytes and excessive whitespace that could be used in injection attacks
      return { ...msg, content: msg.content.replace(/\x00/g, '').trim() };
    });
    
    const lastMessage = sanitizedMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? sanitizeUserInput(lastMessage.content) : "Roast me.";

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
    // Log detailed error internally for debugging
    console.error('CopilotClient error:', error instanceof Error ? error.message : String(error));
    
    // Track token failures for rate limiting
    trackTokenFailure(token);
    
    // Return sanitized error response to prevent information disclosure
    if (!res.headersSent) {
      if (error instanceof Error) {
        if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
          res.status(503).json({ error: 'Service temporarily unavailable' });
        } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          res.status(401).json({ error: 'Authentication failed' });
        } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
          res.status(403).json({ error: 'Access denied' });
        } else {
          res.status(500).json({ error: 'Request processing failed' });
        }
      } else {
        res.status(500).json({ error: 'Request processing failed' });
      }
    }
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});