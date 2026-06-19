import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Circuit breaker for Copilot API calls
class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 60000; // 60 seconds

  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }
}

// Error classification for Copilot API
interface ClassifiedError {
  type: 'transient' | 'permanent' | 'unknown';
  retriable: boolean;
  message: string;
}

const classifyError = (error: any): ClassifiedError => {
  const message = error?.message || String(error);
  const status = error?.status || error?.code;

  if (status === 429 || message.includes('rate limit')) {
    return { type: 'transient', retriable: true, message: 'Rate limited' };
  }
  if (status === 408 || status === 504 || message.includes('timeout') || message.includes('ETIMEDOUT')) {
    return { type: 'transient', retriable: true, message: 'Timeout' };
  }
  if (status === 401 || status === 403 || message.includes('Unauthorized') || message.includes('token')) {
    return { type: 'permanent', retriable: false, message: 'Authentication failed' };
  }
  if (status >= 500) {
    return { type: 'transient', retriable: true, message: 'Server error' };
  }
  return { type: 'unknown', retriable: false, message };
};

// Retry logic for transient errors
const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  backoffMs = 1000
): Promise<T> => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const classified = classifyError(error);
      if (!classified.retriable || attempt === maxRetries - 1) {
        throw error;
      }
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
};

const circuitBreaker = new CircuitBreaker();

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      requestId?: string;
    }
  }
}

// Structured logging
const generateRequestId = (): string => `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const log = (level: 'info' | 'warn' | 'error', message: string, requestId?: string, meta?: any) => {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, requestId, ...meta };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(logEntry));
};

const app = express();

// Validate and parse PORT environment variable
const parsePort = (portEnv: string | undefined): number => {
  const defaultPort = 3000;
  if (!portEnv) return defaultPort;
  
  const parsed = parseInt(portEnv, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    log('warn', `Invalid PORT value '${portEnv}', using default ${defaultPort}`);
    return defaultPort;
  }
  if (parsed < 1024) {
    log('warn', `Port ${parsed} requires elevated privileges (< 1024)`);
  }
  return parsed;
};

const port = parsePort(process.env.PORT);

let limiter;
try {
  limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
} catch (err) {
  log('error', 'Failed to initialize rate limiter', undefined, { error: String(err) });
  process.exit(1);
}

// Apply Helmet security headers
try {
  app.use(helmet());
} catch (err) {
  log('error', 'Failed to initialize Helmet', undefined, { error: String(err) });
  process.exit(1);
}

// Add request ID middleware
app.use((req: Request, res: Response, next) => {
  req.requestId = generateRequestId();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

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

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    circuitBreaker: circuitBreaker.isOpen() ? 'open' : 'closed'
  });
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  try {
  const requestId = req.requestId;
  
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    log('warn', 'WEBHOOK_SECRET not configured - webhook signature verification disabled', requestId);
  } else if (signature) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      log('error', 'Missing raw body for signature verification', requestId);
      return res.status(400).json({ error: 'Missing raw body' });
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    // Use timing-safe comparison
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    ).valueOf();

    if (!isValid) {
      log('warn', 'Invalid webhook signature', requestId);
      res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
      return;
    }
    log('info', 'Webhook signature verified', requestId);
  } else if (webhookSecret) {
    log('warn', 'Webhook signature expected but not provided', requestId);
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  const sanitizedToken = token.trim();
  // Check circuit breaker
  if (circuitBreaker.isOpen()) {
    log('warn', 'Circuit breaker is open - Copilot API unavailable', requestId);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  let client;
  try {
    const clientConfig: any = {
      env: {
        GITHUB_TOKEN: sanitizedToken,
        ...process.env
      }
    };
    
    // Allow configurable endpoint via environment variable
    if (process.env.COPILOT_ENDPOINT) {
      clientConfig.endpoint = process.env.COPILOT_ENDPOINT;
    }
    
    client = new CopilotClient(clientConfig);
    log('info', 'CopilotClient initialized', requestId);
  } catch (initError) {
    const classified = classifyError(initError);
    log('error', 'Failed to initialize CopilotClient', requestId, { errorType: classified.type, message: classified.message });
    if (classified.type === 'permanent') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    circuitBreaker.recordFailure();
    return res.status(500).json({ error: 'Failed to initialize client' });
  }
  
  try {
    // Validate request body
    const bodySize = req.rawBody ? req.rawBody.length : 0;
    if (bodySize > 1048576) { // 1MB limit
      log('warn', 'Request body exceeds size limit', requestId, { size: bodySize });
      return res.status(413).json({ error: 'Payload too large' });
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
    if (!Array.isArray(userMessages)) {
      log('warn', 'Invalid messages format', requestId);
      return res.status(400).json({ error: 'Invalid message format' });
    }
    const lastMessage = userMessages.filter((m: any) => m?.role === 'user').pop();
    const prompt = lastMessage?.content ? String(lastMessage.content) : "Roast me.";
    if (prompt.length > 10000) {
      log('warn', 'Prompt exceeds maximum length', requestId, { length: prompt.length });
      return res.status(400).json({ error: 'Prompt too long' });
    }

    // Create session with retry logic and timeout
    let session;
    try {
      session = await withRetry(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        try {
          return await Promise.race([
            client.createSession({
              model: "gpt-4o",
              streaming: true,
              systemMessage: {
                mode: "replace",
                content: systemPrompt
              }
            }),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => reject(new Error('CopilotClient API timeout')));
            })
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      }, 3, 1000);
      log('info', 'Session created successfully', requestId);
    } catch (apiError) {
      const classified = classifyError(apiError);
      log('error', 'Failed to create Copilot session', requestId, { errorType: classified.type, message: classified.message });
      
      if (classified.type === 'transient') {
        circuitBreaker.recordFailure();
        return res.status(503).json({ error: 'Service temporarily unavailable' });
      } else {
        return res.status(500).json({ error: 'Failed to create session' });
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let responseStarted = false;
    
    session.on((event: any) => {
      try {
        if (event.type === "assistant.message_delta") {
          responseStarted = true;
          const chunk = {
            choices: [{ delta: { content: event.data?.deltaContent || '' } }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch (streamError) {
        log('error', 'Error writing to response stream', requestId, { error: String(streamError) });
      }
    });

    try {
      await session.sendAndWait({ prompt });
      circuitBreaker.recordSuccess();
      log('info', 'Session completed successfully', requestId);
    } catch (sendError) {
      const classified = classifyError(sendError);
      log('error', 'Error sending message to session', requestId, { errorType: classified.type, message: classified.message });
      if (classified.type === 'transient') {
        circuitBreaker.recordFailure();
      }
      if (!responseStarted && !res.headersSent) {
        res.status(500).json({ error: 'Failed to process request' });
      }
      return;
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    const classified = classifyError(error);
    log('error', 'Error in POST /agent handler', requestId, { errorType: classified.type, message: classified.message });
    if (classified.type === 'transient') {
      circuitBreaker.recordFailure();
    }
    if (!res.headersSent) res.status(500).json({ error: 'The roaster overheated' });
  } finally {
    try {
      if (client) await client.stop();
    } catch (stopError) {
      log('warn', 'Error stopping Copilot client', requestId, { error: String(stopError) });
    }
  }
  } catch (handlerError) {
    const requestId = (req as any).requestId || 'unknown';
    log('error', 'Unhandled error in POST /agent handler', requestId, { error: String(handlerError) });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});