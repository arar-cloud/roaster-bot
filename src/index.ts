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

// Validate required environment variables at startup
if (!process.env.WEBHOOK_SECRET) {
  throw new Error('WEBHOOK_SECRET environment variable is required. Set it before starting the server.');
}
if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is required. Set it before starting the server.');
}

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Retry utility with exponential backoff
interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    backoffMultiplier = 2,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isLastAttempt = attempt === maxAttempts;

      if (isLastAttempt) break;

      // Exponential backoff with jitter
      const delayMs = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt - 1) + Math.random() * 1000,
        maxDelayMs
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Retry failed after max attempts');
}

// Timeout utility for async operations
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string = 'operation'
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Set payload size limit
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    if (buf.length > MAX_PAYLOAD_SIZE) {
      throw new Error(`Payload size ${buf.length} exceeds maximum allowed size ${MAX_PAYLOAD_SIZE}`);
    }
    req.rawBody = buf.toString('utf8');
  }
}));

// Error handler for body parsing failures - applies before route handlers
app.use((err: any, req: Request, res: Response, next: Function) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err.message && err.message.includes('Payload size')) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  next(err);
});

// Global error handlers to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // In production, log to monitoring service and consider graceful shutdown
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Attempt graceful shutdown
  process.exit(1);
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
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token with error handling
  let client: CopilotClient;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('CopilotClient initialization failed (token may be invalid):', errorMsg);
    return res.status(500).json({ error: 'Failed to initialize GitHub client' });
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
    const session = await withTimeout(
      client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      }),
      30000,
      'CopilotClient createSession request'
    );

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
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Session error (token may have expired):', errorMsg);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    try {
      await client.stop();
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});