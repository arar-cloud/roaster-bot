import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Sanitize sensitive data from logs to prevent token exposure
const sanitizeForLogging = (obj: any): any => {
  if (typeof obj !== 'object' || obj === null) return obj;
  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };
  const sensitiveKeys = ['token', 'authorization', 'copilot_token', 'api_key', 'password', 'secret'];
  for (const key in sanitized) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeForLogging(sanitized[key]);
    }
  }
  return sanitized;
};

// Retry wrapper for external API calls with exponential backoff
// Auth middleware: validate API key token without exposing it in logs
const verifyApiKey = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7); // Remove 'Bearer '
  const validToken = process.env.API_KEY;
  if (!validToken || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(validToken))) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
};

const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> => {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, i); // exponential backoff: 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  const logError = lastError instanceof Error ? { message: lastError.message } : {};
  console.error('Retry exhausted:', sanitizeForLogging(logError));
  throw lastError || new Error('Retries exhausted');
};

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();

// Request-scoped memoization cache for Copilot API calls
const requestCacheMap = new WeakMap<Request, Map<string, Promise<any>>>();

const getMemoizedResponse = async <T>(
  req: Request,
  cacheKey: string,
  fn: () => Promise<T>
): Promise<T> => {
  if (!requestCacheMap.has(req)) {
    requestCacheMap.set(req, new Map());
  }
  const cache = requestCacheMap.get(req)!;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }
  const promise = fn();
  cache.set(cacheKey, promise);
  return promise;
};
const port = process.env.PORT || 3000;
let isHealthy = true;

const rateLimitKeyCache = new Map<string, string>();

const getCachedRateLimitKey = (req: Request): string => {
  const ip = req.ip || 'unknown';
  if (rateLimitKeyCache.has(ip)) {
    return rateLimitKeyCache.get(ip)!;
  }
  const key = `rl:${ip}`;
  rateLimitKeyCache.set(ip, key);
  // Evict oldest cache entry when size exceeds threshold to prevent unbounded growth
  if (rateLimitKeyCache.size > 10000) {
    const firstKey = rateLimitKeyCache.keys().next().value;
    rateLimitKeyCache.delete(firstKey);
  }
  return key;
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getCachedRateLimitKey(req),
});

// Input validation middleware for user commands
const validateUserInput = (req: Request, res: Response, next: NextFunction) => {
    const { code, messages } = req.body;

  // Validate content-type
  const contentType = req.get('Content-Type');
  if (contentType && !contentType.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }

  // Validate code field exists and is string (prevent injection)
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'Invalid code format' });
  }
  if (code.length > 50000) {
    return res.status(413).json({ error: 'Code payload exceeds maximum size' });
  }
  // Prevent dangerous patterns: eval, Function constructor, exec, spawn
  if (/\b(eval|Function|exec|spawn|require|import)\s*\(/.test(code)) {
    return res.status(400).json({ error: 'Code contains restricted operations' });
  }

  // Validate messages array
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages must be an array' });
  }
  if (messages.length === 0 || messages.length > 100) {
    return res.status(400).json({ error: 'Messages array length must be 1-100' });
  }
  for (const msg of messages) {
    if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
      return res.status(400).json({ error: 'Invalid message format' });
    }
    if (!['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).json({ error: 'Invalid message role' });
    }
    if (msg.content.length > 10000) {
      return res.status(413).json({ error: 'Message content exceeds maximum size' });
    }
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

app.use(helmet());
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
  limit: '1mb'
}));
app.use(limiter);

// Error handler middleware for graceful degradation
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const isDev = process.env.NODE_ENV === 'development';
  console.error('Unhandled error:', isDev ? err : err.message);
  isHealthy = false;
  if (!res.headersSent) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(503).json({ error: 'Service temporarily unavailable', ...(isDev && { message: err.message }) });
  }
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(isHealthy ? 200 : 503).json({ healthy: isHealthy });
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

app.post('/agent', limiter, verifyApiKey, validateUserInput, async (req: Request, res: Response, next: NextFunction) => {
  // Webhook signature verification - moved to async validation with early response
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    // Validate required headers and payload
    if (typeof signature !== 'string') {
      return res.status(400).json({ error: 'Invalid signature header' });
    }

    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    // Perform signature validation asynchronously without blocking event loop
    // Use Promise.allSettled to prevent single validation failure from blocking downstream
    const validationResult = await (async () => {
      const encoder = new TextEncoder();
      try {
        const keyData = await crypto.subtle.importKey(
          'raw',
          encoder.encode(webhookSecret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signatureBuffer = await crypto.subtle.sign('HMAC', keyData, encoder.encode(rawBody));
        const digest = 'sha256=' + Buffer.from(signatureBuffer).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
      } catch (e) {
        return false;
      }
    })();
    
    if (!validationResult) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token using retry logic
  const client = await retryWithBackoff(
    () => Promise.resolve(
      new CopilotClient({
        env: {
          GITHUB_TOKEN: token,
          ...process.env
        }
      })
    )
  );

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

    // Create session following SDK docs with retry logic
    const sessionCacheKey = `session:${Buffer.from(systemPrompt).toString('base64').slice(0, 32)}`;
    const session = await getMemoizedResponse(req, sessionCacheKey, () =>
      retryWithBackoff(() =>
        client.createSession({
          model: "gpt-4o",
          streaming: true,
          systemMessage: {
            mode: "replace",
            content: systemPrompt
          }
        })
      )
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
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

    const sendCacheKey = `send:${Buffer.from(prompt).toString('base64').slice(0, 32)}`;
    await getMemoizedResponse(req, sendCacheKey, () =>
      retryWithBackoff(() => session.sendAndWait({ prompt }), 3, 1000)
    );

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isDev = process.env.NODE_ENV === 'development';
    const sanitizedError = sanitizeForLogging({ timestamp: new Date().toISOString(), error: errorMsg, ...(isDev && { stack: error instanceof Error ? error.stack : undefined }) });
    console.error('[WEBHOOK_ERROR]', sanitizedError);
    // Pass to error middleware instead of sending response directly
    if (!res.headersSent) {
      next(error);
    }
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

// Initialize clients with proper lifecycle management
let copilotReady = false;
let server: any = null;

function initializeClients() {
  try {
    if (process.env.COPILOT_TOKEN) {
      const testClient = new CopilotClient({ token: process.env.COPILOT_TOKEN });
      console.log('Copilot client initialized successfully');
      copilotReady = true;
    } else {
      console.warn('Warning: COPILOT_TOKEN not set. Copilot features disabled.');
    }
  } catch (error) {
    console.error('Warning: Copilot client initialization failed. Running in degraded mode.');
    console.error(error instanceof Error ? error.message : String(error));
    copilotReady = false;
    isHealthy = false;
  }
}

// Graceful shutdown handler
function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}, initiating graceful shutdown...`);
  if (server) {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
    // Force exit after 30 seconds if graceful close doesn't complete
    setTimeout(() => {
      console.error('Forced shutdown due to timeout');
      process.exit(1);
    }, 30000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

initializeClients();

server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  isHealthy = true;
});

server.on('error', (error: any) => {
  console.error('Server error:', error);
  isHealthy = false;
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use`);
    process.exit(1);
  }
});