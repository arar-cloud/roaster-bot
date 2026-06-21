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

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const AGENT_TIMEOUT_MS = 30000; // 30 second timeout for agent processing
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRetryable = error instanceof Error && 
        (error.message.includes('timeout') || 
         error.message.includes('ECONNREFUSED') ||
         error.message.includes('ECONNRESET') ||
         error.message.includes('429') ||
         error.message.includes('503'));
      
      if (!isRetryable || attempt === maxRetries - 1) break;
      
      const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      console.warn(`Attempt ${attempt + 1} failed, retrying in ${backoffMs}ms:`, error);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

app.use(express.json({
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

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret) {
    if (!signature) {
      console.warn('Webhook signature missing from request');
      return res.status(403).json({ error: 'Webhook signature required' });
    }

    const rawBody = req.rawBody;
    if (!rawBody || typeof rawBody !== 'string' || rawBody.length === 0) {
      console.warn('Invalid webhook body for signature verification');
      return res.status(400).json({ error: 'Invalid webhook body' });
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest) {
      console.warn(`Webhook signature mismatch. Expected: ${digest}, Got: ${signature}`);
      return res.status(403).json({ error: 'Webhook signature verification failed' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).json({ error: 'Missing X-GitHub-Token header' });

  const message = req.body.message || '';
  if (!message) {
    return res.status(400).json({ error: 'Missing message in request body' });
  }

  // Initialize client with the user's token
  let client: CopilotClient;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (err) {
    console.error('Failed to initialize CopilotClient:', err);
    throw new Error(`CopilotClient initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // Wrap async operation with timeout and success response
    const response = await withTimeout(
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: message }],
      }),
      AGENT_TIMEOUT_MS
    );

    const responseText = response.choices[0]?.message?.content || '';
    return res.status(200).json({ response: responseText });

    // Original streaming code preserved below (not executed)
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

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}, closing server gracefully...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));