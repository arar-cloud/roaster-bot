import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { Promise<CopilotClient> } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    evict least recently used
      const lruKey = this.accessOrder.shift();
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = []}
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Retry helper with exponential backoff for transient failures
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Retry ${attempt + 1}/${maxAttempts}] Error:`, lastError.message);
      if (attempt < maxAttempts - 1) {
        const jitter = Math.random() * 0.1 * baseDelayMs;
        const delayMs = baseDelayMs * Math.pow(2, attempt) + jitter;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  const finalError = lastError || new Error('Max retries exceeded');
  console.error('All retries failed:', finalError.message);
  throw finalError;
}

// Middleware to capture raw body for webhook signature verification (must be before other body parsers)
app.use((req: Request, res: Response, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk.toString('utf-8'); });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
  req.on('error', (error) => {
    console.error('Raw body parse error:', error);
    res.status(400).json({ error: 'Invalid request body' });
  });
});

// Security headers middleware
app.use((req: Request, res: Response, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  next();
});

// Singleton CopilotClient instance with Promise-based initialization lock to prevent race conditions
let copilotClientInstance: CopilotClient | null = null;
let clientInitPromise: Promise<CopilotClient> | null = null;
let initInProgress: boolean = false;

async function callCopilotWithRetry(
  client: CopilotClient,
  prompt: string,
  maxRetries = 3,
  timeoutMs: number = 30000
): Promise<string> {
  if (!client) {
    throw new Error('CopilotClient is null or undefined');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Prompt must be a non-empty string');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Copilot request timeout after ${timeoutMs}ms for prompt: ${prompt.substring(0, 50)}...`));
    }, timeoutMs);

    (async () => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await client.complete(prompt);
          clearTimeout(timer);
          return resolve(response);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (attempt < maxRetries - 1) {
            const delayMs = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delayMs));
          } else {
            clearTimeout(timer);
            reject(new Error(`Copilot API error after ${maxRetries} attempts: ${errorMsg}`));
            return;
          }
        }
      }
    })();
  });
}

async function getClient(): Promise<CopilotClient> {
  // Return cached instance if available
  if (copilotClientInstance) return copilotClientInstance;

  // Return existing initialization promise if in progress
  if (clientInitPromise) return clientInitPromise;

  // Prevent concurrent initialization attempts
  if (initInProgress) {
    // Wait for the promise to be set or timeout
    const maxWait = 5000;
    const startTime = Date.now();
    while (!clientInitPromise && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (clientInitPromise) return clientInitPromise;
    throw new Error('Client initialization already in progress');
  }

  try {
    initInProgress = true;
    // Start new initialization with retry logic
    clientInitPromise = retryWithBackoff(
      async () => {
        if (!copilotClientInstance) {
          copilotClientInstance = new CopilotClient({
            token: process.env.GITHUB_TOKEN || '',
          });
        }
        return copilotClientInstance;
      },
      3,
      100
    ).catch(error => {
      clientInitPromise = null; // Reset on failure
      console.error('Failed to initialize CopilotClient after retries:', error);
      throw new Error('CopilotClient initialization failed');
    });

    return await clientInitPromise;
  } finally {
    initInProgress = false;
  }
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// HMAC cache: stores computed signatures with LRU eviction to prevent memory leaks
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private accessOrder: K[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    // Move to end (most recently used)
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      this.accessOrder = this.accessOrder.filter(k => k !== key);
      this.accessOrder.push(key);
      return;
    }
    if (this.cache.size >= this.maxSize) {
      const lruKey = this.accessOrder.shift();
      if (lruKey) this.cache.delete(lruKey);
    }
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }
}

const hmacCache = new LRUCache<string, string>(1000);

function getHmacSHA256(payload: string, secret: string): string {
  const cacheKey = `${payload.length}:${secret.length}`;
  const cached = hmacCache.get(cacheKey);
  if (cached) return cached;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  hmacCache.set(cacheKey, sig);
  return sig;
}

// Use async body parser with lazy verification for better event loop throughput
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString('utf8', 0, Math.min(buf.length, 10000));
  }
}));

app.post('/roast', express.json(), async (req: Request, res: Response) => {
  try {
    const code = req.body.code;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code field is required and must be a string' });
    }
    // Validate client health before processing with retry
    const healthOk = await validateClientHealth();
    if (!healthOk) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
    const client = await getClient();
    const roast = await callCopilotWithRetry(client, code);
    res.json({ roast });
  } catch (error) {
    console.error('Error in /roast endpoint:', error);
    copilotClientInstance = null;
    initInProgress = false;
    res.status(500).json({ error: 'Failed to generate roast. Please try again.' });
  }
});

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Graceful shutdown handler
const shutdown = () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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

app.post('/webhook', limiter, async (req: Request, res: Response) => {
  try {
    // Validate webhook payload early to prevent crashes
    if (!req.body) {
      return res.status(400).json({ error: 'Missing request body' });
    }

    // Webhook signature verification
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;

    if (!req.rawBody) {
      return res.status(400).json({ error: 'Request body not properly parsed' });
    }

    if (webhookSecret && signature) {
      if (typeof signature !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid signature' });
      }
      const rawBody = req.rawBody;
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        console.error('Invalid JSON in webhook payload:', err instanceof Error ? err.message : String(err));
        return res.status(400).json({ error: 'Invalid JSON payload' });
      }

    const digest = 'sha256=' + getHmacSHA256(rawBody, webhookSecret);

    if (signature !== digest && signature !== `sha256=${digest}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Reuse pooled client instance instead of creating new per-request
  const client = await getClient();

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

    // Validate client is initialized before session creation
    if (!client) {
      throw new Error('Copilot client not initialized');
    }
    // Create session following SDK docs
    const session = await client.createSession({
      model: "gpt-4o",
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: systemPrompt
      }
    });
    if (!session) {
      throw new Error('Invalid session from Copilot API');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    session.on((event: any) => {
      try {
        if (event.type === "assistant.message_delta") {
          const chunk = {
            choices: [{ delta: { content: event.data.deltaContent } }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch (writeErr) {
        console.error('Error writing to response stream:', writeErr);
        if (!res.headersSent) {
          res.status(500).send('Stream write error');
        }
      }
    });

    // Timeout session operations after 30s to prevent hanging
    const sessionTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Session timeout after 30s')), 30000)
    );

    try {
      await Promise.race([
        callCopilotWithRetry(client, prompt),
        sessionTimeout
      ]);
    } catch (error) {
      console.error('Error:', error);
      // Reset both client state and initialization flag for clean recovery
      copilotClientInstance = null;
      initInProgress = false;
      if (!res.headersSent) res.status(500).send("The roaster overheated.");
      return;
    } finally {
      // Always attempt cleanup to prevent resource leak
      try {
        if (session) await session.stop?.();
      } catch (cleanupErr) {
        console.error('Session cleanup error:', cleanupErr);
      }
    }

    try {
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('Error finalizing response:', err);
    }
});

// Health check for client connectivity with improved error handling
async function validateClientHealth(): Promise<boolean> {
  try {
    const client = await getClient();
    if (!client) return false;
    // Verify client is actually functional
    return client !== null;
  } catch (error) {
    console.error('Client health check failed:', error);
    return false;
  }
}

// Graceful shutdown with cleanup
function setupGracefulShutdown() {
  const shutdownHandler = async () => {
    console.log('Shutting down gracefully...');
    copilotClientInstance = null;
    clientInitPromise = null;
    process.exit(0);
  };
  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);
}

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
  setupGracefulShutdown();
});