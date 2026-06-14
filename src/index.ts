import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// Validate environment variables at startup
function validateEnvironment() {
  const requiredVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];
  const missing = requiredVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  if (typeof process.env.WEBHOOK_SECRET !== 'string' || process.env.WEBHOOK_SECRET.length === 0) {
    console.error('FATAL: WEBHOOK_SECRET must be a non-empty string');
    process.exit(1);
  }
  
  if (typeof process.env.GITHUB_TOKEN !== 'string' || process.env.GITHUB_TOKEN.length === 0) {
    console.error('FATAL: GITHUB_TOKEN must be a non-empty string');
    process.exit(1);
  }
}

validateEnvironment();

// Logging utility for observability
function logError(context: string, error: any, metadata?: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  console.error(JSON.stringify({
    timestamp,
    level: 'ERROR',
    context,
    message: errorMessage,
    stack: errorStack,
    ...metadata
  }));
}

function logInfo(context: string, message: string, metadata?: Record<string, any>) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    level: 'INFO',
    context,
    message,
    ...metadata
  }));
}

// Timeout wrapper for API calls
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context: string = 'api-call'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms in ${context}`)), timeoutMs)
    )
  ]);
}

// Retry logic with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100,
  context: string = 'api-call',
  timeoutMs: number = 30000
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const isTransient = error?.status === 429 || error?.code === 'ECONNRESET' || 
                         error?.code === 'ETIMEDOUT' || error?.code === 'ENOTFOUND';
      const isLastAttempt = attempt === maxRetries - 1;
      
      if (!isTransient || isLastAttempt) {
        throw error;
      }
      
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      logInfo(context, `Transient error, retrying after ${delayMs}ms`, {
        attempt: attempt + 1,
        maxRetries,
        error: error?.message || String(error)
      });
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' // Skip health checks
});

// Apply rate limiting to all endpoints
app.use(limiter);

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    // Validate buffer size before string conversion to prevent memory exhaustion
    if (buf.length > 1024 * 1024) {
      throw new Error('Request body exceeds maximum size limit (1MB)');
    }
    req.rawBody = buf.toString('utf-8');
  }
}));

// Webhook signature verification middleware
function verifyWebhookSignature(req: any, res: Response, next: Function) {
  // Enforce webhook signature verification for all POST requests
  if (req.method === 'POST' && req.path !== '/health') {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody;
    
    if (!signature || !rawBody) {
      logError('webhook-verification', 'Missing signature or body', {
        hasSignature: !!signature,
        hasBody: !!rawBody,
        ip: req.ip,
        path: req.path
      });
      return res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
    }
    
    const webhookSecret = process.env.WEBHOOK_SECRET as string;
    const expectedSignature = 'sha256=' + 
      crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    
    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(signature.toString(), expectedSignature)) {
      logError('webhook-verification', 'Signature mismatch', {
        ip: req.ip,
        path: req.path,
        received: signature.toString().substring(0, 16) + '...'
      });
      return res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
    }
    
    logInfo('webhook-verification', 'Signature valid', { ip: req.ip });
  }
  next();
}

app.use(verifyWebhookSignature);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.post('/agent', limiter, async (req: Request, res: Response) => {
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
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

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
    let session;
    try {
      session = await retryWithBackoff(
        () => client.createSession({
          model: "gpt-4o",
          streaming: true,
          systemMessage: {
            mode: "replace",
            content: systemPrompt
          }
        }),
        3,
        100,
        'copilot-createSession',
        30000
      );
    } catch (apiError: any) {
      logError('post-agent', apiError, {
        context: 'CopilotClient.createSession',
        ip: req.ip
      });
      return res.status(503).json({ error: 'External API call failed after retries' });
    }

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

const server = app.listen(port, () => {
  logInfo('startup', `Server running on port ${port}`);
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  logInfo('shutdown', 'SIGTERM received, draining connections');
  server.close(() => {
    logInfo('shutdown', 'Server closed gracefully');
    process.exit(0);
  });
  // Force exit after 30 seconds
  setTimeout(() => {
    logError('shutdown', 'Forced shutdown after 30s timeout');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', () => {
  logInfo('shutdown', 'SIGINT received, draining connections');
  server.close(() => {
    logInfo('shutdown', 'Server closed gracefully');
    process.exit(0);
  });
  // Force exit after 30 seconds
  setTimeout(() => {
    logError('shutdown', 'Forced shutdown after 30s timeout');
    process.exit(1);
  }, 30000);
});