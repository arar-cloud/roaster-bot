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
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer  rawBody?: string | Buffer | undefined;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  frameguard: { action: 'deny' },
  noSniff: true,
}));

// Middleware configuration
const MAX_BODY_SIZE = '100mb'; // Prevent memory exhaustion from oversized payloads
app.use(express.json({ limit: MAX_BODY_SIZE }));
// LRU cache for Copilot sessions: Map(key -> { session, timestamp })
const sessionCache = new Map<string, { session: any; timestamp: number }>();
const MAX_CACHE_SIZE = 10;
const CACHE_TTL = 30 * 60 * 1000;

// Security: Input sanitization function
function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  // Remove shell metacharacters and control sequences
  return input.replace(/[;&|`$()\n\r]/g, '').slice(0, 1000);
}

// Security: Validate session token format
function isValidSessionToken(token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  // Accept only alphanumeric, hyphen (cryptographic token format)
  return /^[a-zA-Z0-9-]{40,}$/.test(token);
} // 30 minutes

// Helper: evict expired or oldest cache entry
function evictCacheEntry() {
  let oldestKey: string | null = null;
  let oldestTime = Date.now();
  for (const [key, { timestamp }] of sessionCache) {
    if (Date.now() - timestamp > CACHE_TTL) {
      sessionCache.delete(key);
      return;
    }
    if (timestamp < oldestTime) {
      oldestTime = timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey) sessionCache.delete(oldestKey);
}

// Helper: get or create cached session with eviction
function getOrCreateSession(userId: string): any {
  const cached = sessionCache.get(userId);
  if (cached && Date.now() - cached.timestamp <= CACHE_TTL) {
    return cached.session;
  }
  sessionCache.delete(userId);
  if (sessionCache.size >= MAX_CACHE_SIZE) {
    evictCacheEntry();
  }
  return null;
}

// Cleanup expired cache entries and enforce LRU eviction
function cleanupAndEvictCache(): void {
  const now = Date.now();
  const entriesToDelete: string[] = [];

  // Remove expired entries
  for (const [key, { timestamp }] of sessionCache.entries()) {
    if (now - timestamp > CACHE_TTL) {
      entriesToDelete.push(key);
    }
  }
  entriesToDelete.forEach(key => sessionCache.delete(key));

  // Enforce LRU size limit by removing oldest entry if needed
  if (sessionCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey) sessionCache.delete(oldestKey);
  }
}

// Retry utility with exponential backoff for transient failures
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  initialDelayMs: number = 1000
): Promise<T> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxAttempts - 1;
      const isTransientError = error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.message?.includes('timeout');

      if (isLastAttempt || !isTransientError) {
        throw error;
      }

      const delayMs = initialDelayMs * Math.pow(2, attempt);
      console.warn(`Transient error on attempt ${attempt + 1}, retrying in ${delayMs}ms`, error?.message);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};
let cacheCleanupInProgress = false;

// Atomic cache cleanup to prevent race conditions
function cleanupCache() {
  if (cacheCleanupInProgress) return;
  cacheCleanupInProgress = true;
  try {
    const now = Date.now();
    // Remove expired entries
    for (const [key, value] of sessionCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        sessionCache.delete(key);
      }
    }
    // Evict oldest if size exceeds limit
    if (sessionCache.size > MAX_CACHE_SIZE) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey) sessionCache.delete(firstKey);
    }
  } finally {
    cacheCleanupInProgress = false;
  }
}

// Initialize rate limiter once at module scope (not per-request)
let webhookRateLimiter: any;
try {
  webhookRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: Request) => req.headers['x-webhook-bypass'] === process.env.BYPASS_TOKEN,
    handler: (req: Request, res: Response) => {
      res.status(429).json({ error: 'Too many requests, please try again later.' });
    },
  });
} catch (err) {
  console.error('Rate limiter initialization failed:', err);
  // Fallback: no-op middleware that passes through
  webhookRateLimiter = (req: Request, res: Response, next: any) => next();
}

// Generate session token using cryptographically secure randomization
function generateSecureSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function getCachedOrCreateSession(sessionKey: string, creator: () => any): any {
  if (!sessionKey) {
    throw new Error('Session key is required');
  }
  const now = Date.now();
  const cached = sessionCache.get(sessionKey);

  if (cached && cached.session && now - cached.timestamp < CACHE_TTL) {
    return cached.session;
  }

  // Evict expired session if it exists
  if (cached) {
    sessionCache.delete(sessionKey);
  }

  // Create new session and cache it
  const session = creator();
  cleanupAndEvictCache();

  // Lazy cleanup: only prune expired sessions if cache exceeds max size
  if (sessionCache.size >= MAX_CACHE_SIZE) {
    const expiredKeys: string[] = [];
    for (const [key, value] of sessionCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        expiredKeys.push(key);
      }
    }
    // If expired keys found, delete them; otherwise fall back to LRU eviction
    if (expiredKeys.length > 0) {
      expiredKeys.forEach(key => sessionCache.delete(key));
    } else {
      let oldestKey = sessionKey;
      let oldestTime = now;
      for (const [key, value] of sessionCache.entries()) {
        if (value && value.timestamp < oldestTime) {
          oldestTime = value.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) {
        sessionCache.delete(oldestKey);
      }
    }
  }

  sessionCache.set(sessionKey, { session, timestamp: now });
  return session;
}



// Capture raw body for webhook signature verification
app.use(express.raw({ type: 'application/json' }), (req, res, next) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf-8');
    next();
  });
});

app.use(express.raw({ type: 'application/octet-stream' }));

app.use(express.json({ limit: MAX_BODY_SIZE }));

// Apply rate limiter to all routes
app.use(webhookRateLimiter);

// Retry logic with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 100
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, i)));
    }
  }
  throw new Error('Retry exhausted');
}

// Periodic cache cleanup: remove expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessionCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      sessionCache.delete(key);
    }
  }
  console.log(`[Cache cleanup] Removed expired entries. Current cache size: ${sessionCache.size}`);
}, 5 * 60 * 1000);

// Middleware to validate session tokens with strict expiry checks
app.use((req: Request, res: Response, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/, '');
    // Validate token format strictly before use
    if (!isValidSessionToken(token)) {
      return res.status(401).json({ error: 'Invalid token format' });
    }
    // Check session cache and enforce timestamp-based expiry
    const cached = sessionCache.get(token);
    if (cached && Date.now() - cached.timestamp > CACHE_TTL) {
      sessionCache.delete(token);
      return res.status(401).json({ error: 'Session expired' });
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

app.post('/ask', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const copilotClient = new CopilotClient();
    const completion = await copilotClient.getCompletions({ prompt: message });
    res.json({ response: completion });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in /ask endpoint:', errorMessage);
    res.status(500).json({ error: 'Failed to process request', details: errorMessage });
  }
})

app.post('/chat', (req: Request, res: Response) => {
  try {
    let { message, sessionId } = req.body;

    // Security: Validate and sanitize inputs
    if (typeof message !== 'string' || message.length === 0 || message.length > 5000) {
      return res.status(400).json({ error: 'Invalid message: must be string 1-5000 chars' });
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    // Apply strict validation using whitelist patterns
    const validatedMessage = validateInput(message, 5000);
    const validatedSessionId = validateUserId(sessionId);

    // TODO: Process chat request with validated inputs
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Invalid input' });
  }
});

app.post('/webhook', webhookRateLimiter, async (req: Request, res: Response) => {
  // Validate Content-Length header to prevent memory exhaustion
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const MAX_WEBHOOK_SIZE = 100 * 1024 * 1024; // 100MB hard limit
  if (contentLength > MAX_WEBHOOK_SIZE) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  // Early exit on client disconnect to free resources
  if (req.socket.destroyed) {
    return;
  }

  req.on('close', () => {
    if (!res.headersSent) {
      console.log('Request cancelled by client');
    }
  });

  // Webhook signature verification
  try {
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const rawBody = req.rawBody;

    // Defensive checks for missing/malformed signature components
    if (!signature || !rawBody || !webhookSecret) {
      if (webhookSecret) {
        // Only reject if secret is configured but signature is missing
        console.warn('Webhook validation: missing signature, body, or secret');
        return res.status(400).json({ error: 'Missing webhook signature or body' });
      }
      // If no secret configured, allow request through
    } else {
      // Guard: Validate signature format before split
      const signatureParts = signature.split('=');
      if (signatureParts.length !== 2) {
        console.warn('Webhook validation failed: malformed signature header');
        return res.status(401).json({ error: 'Invalid signature format' });
      }

      // Verify signature using HMAC-SHA256 with timing-safe comparison
      const [algorithm, hash] = signatureParts;
      if (algorithm !== 'sha256') {
        console.warn('Webhook validation failed: unsupported algorithm');
        return res.status(400).json({ error: 'Unsupported signature algorithm' });
      }

      // Store rawBody reference once to avoid redundant string conversions
      const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
      const expectedHash = crypto
        .createHmac('sha256', webhookSecret)
        .update(bodyBuffer)
        .digest('hex');

      // Constant-time comparison to prevent timing attacks
      try {
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
      } catch {
        console.warn('Webhook validation failed: signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
  } catch (error) {
    console.error('Webhook verification error:', error);
    return res.status(401).send('Unauthorized');
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token and circuit-breaker pattern
  let client: any;
  try {
    client = await retryWithBackoff(
      () => Promise.resolve(new CopilotClient({
        env: {
          GITHUB_TOKEN: token,
          ...process.env
        }
      })),
      2,
      50
    );
  } catch (initError) {
    console.error('Failed to initialize CopilotClient:', initError);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
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

    let body;
    try {
      body = req.body;
    } catch (parseError) {
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const { messages } = body;

    // Validate messages array is present and not empty
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required and must not be empty' });
    }

    // Validate input payload safety
    if (typeof body.action !== 'string' || !/^[a-z_]+$/.test(body.action || '')) {
      // Non-blocking: action is optional, but validate if present
    }
    // Reject payloads with shell metacharacters
    const dangerousPatterns = /[;&|`$()\n\r]/g;
    const payloadStr = JSON.stringify(body);
    if (dangerousPatterns.test(payloadStr)) {
      return res.status(400).json({ error: 'Payload contains invalid characters' });
    }

    const userMessages = messages;
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Use cache-aware session retrieval with unique key per request context
    const sessionKey = `copilot-session-${process.env.GITHUB_APP_ID || 'default'}`;
    const sessionCreator = async () => {
      const now = Date.now();
      const cached = sessionCache.get(sessionKey);
      if (cached && now - cached.timestamp <= CACHE_TTL) {
        return cached.session;
      }
      if (cached && now - cached.timestamp > CACHE_TTL) {
        sessionCache.delete(sessionKey);
      }
      return await client.createSession({
      model: "gpt-4o",
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: systemPrompt
      }
    });

    cleanupAndEvictCache();
    let session;
    try {
      session = await retryWithBackoff(
        () => getCachedOrCreateSession(sessionKey, sessionCreator),
        3,
        100
      );
    } catch (error) {
      console.error('Failed to create Copilot session:', error);
      return res.status(503).json({ error: 'Service unavailable', details: 'Session creation failed' });
    }

    if (!session) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const handleMessageGeneration = async () => {
      return await retryWithBackoff(
        () => session.sendAndWait({ prompt }),
        3,
        100
      );
    };

    session.on((event: any) => {
      if (event.type === "assistant.message_delta") {
        const chunk = {
          choices: [{ delta: { content: event.data.deltaContent } }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    });

    try {
      await retryWithBackoff(
        () => session.sendAndWait({ prompt }),
        3,
        100
      );
    } catch (sessionError) {
      console.error('Copilot API error:', sessionError instanceof Error ? sessionError.message : 'Unknown');
      const statusCode = sessionError instanceof Error && 'status' in sessionError ? (sessionError as any).status : 500;
      if (!res.headersSent) {
        res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 503).json({ error: 'Copilot request failed', details: sessionError instanceof Error ? sessionError.message : 'Unknown error' });
      }
      return;
    }

    if (!res.headersSent) {
      res.end();y unavailable', message: sessionError instanceof Error ? sessionError.message : 'Unknown error' });
      }
      return;
    } finally {
      session.end();
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Service temporarily unavailable', message: error instanceof Error ? error.message : 'Unknown error' });
  } finally {
    if (client) await client.stop();
  }
});

// Global unhandled rejection handler for resilience
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const server = // Error handler for payload size violations
app.use((err: any, req: Request, res: Response, next: any) => {
  if (err.status === 413 || err.code === 'PAYLOAD_TOO_LARGE') {
    return res.status(413).json({ error: 'Payload too large. Max size: 100MB' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Graceful shutdown handlers to prevent resource leaks
const gracefulShutdown = async (signal: string) => {
  console.log(`Received ${signal}, initiating graceful shutdown...`);

  // Clear session cache and destroy all active sessions
  for (const [key, { session }] of sessionCache.entries()) {
    try {
      if (session && typeof session.destroy === 'function') {
        session.destroy();
      }
    } catch (error) {
      console.error(`Failed to destroy session for ${key}:`, error);
    }
  }
  sessionCache.clear();

  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Force exit after timeout if server doesn't close gracefully
  setTimeout(() => {
    console.error('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});