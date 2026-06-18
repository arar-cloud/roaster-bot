import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Timeout wrapper for external API calls
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`${operation} timeout after ${timeoutMs}ms`);
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
};

// Exponential backoff retry logic for transient failures
const withRetry = async <T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number = 2,
  baseDelayMs: number = 100
): Promise<T> => {
  let lastError: Error = new Error(`${operation} failed after all retries`);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Do not retry on authentication or validation errors
      if (err.status === 401 || err.status === 400 || err.code === 'INVALID_SIGNATURE') {
        throw err;
      }
      // Only retry on transient errors
      if (attempt < maxRetries && (err.code === 'ETIMEDOUT' || err.status >= 500)) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.warn(`${operation} attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`, err.message);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
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
const port = process.env.PORT || 3000;

// Validate required environment variables at startup
const requiredEnvVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use((err: any, req: Request, res: Response, next: any) => {
  console.error(`[ERROR] ${new Date().toISOString()} - ${req.method} ${req.url} - ${err.message}`, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
  next();
});

app.use((req: Request, res: Response, next: any) => {
  const originalSend = res.send;
  res.send = function(data: any) {
    res.send = originalSend;
    const result = res.send(data);
    res.on('finish', () => {
      if ((req as any).copilotClient) {
        delete (req as any).copilotClient;
      }
      if ((req as any).rawBody) {
        delete (req as any).rawBody;
      }
    });
    return result;
  };
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
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
  // Initialize rate limiter context
  res.locals.rateLimitFailed = false;
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  try {
    const isValidSignature = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    if (!isValidSignature) {
      res.locals.rateLimitFailed = true;
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    res.locals.rateLimitFailed = true;
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  let client: CopilotClient;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (initError) {
    console.error('CopilotClient initialization failed:', initError);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to initialize Copilot client' });
    }
    return;
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

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});