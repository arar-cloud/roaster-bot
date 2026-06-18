import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { config } from './config.js';
import {
  logError,
  AuthenticationError,
  ValidationError,
  ExternalServiceError,
  retryWithBackoff,
} from './errors.js';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

function validateWebhookPayload(
  payload: any
): { valid: boolean; error?: string } {
  if (!payload.action) {
    return { valid: false, error: 'Missing action field' };
  }
  if (!payload.issue && !payload.pull_request) {
    return {
      valid: false,
      error: 'Missing issue or pull_request field',
    };
  }
  if (!payload.repository) {
    return { valid: false, error: 'Missing repository field' };
  }
  return { valid: true };
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

app.post('/agent', async (req: Request, res: Response) => {
  // Webhook signature verification with early exit
  const signature = req.get('X-Hub-Signature-256') as string | undefined;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!signature) {
    logError(
      new AuthenticationError('Missing webhook signature'),
      { path: req.path, method: req.method }
    );
    return res.status(401).json({ error: 'Unauthorized: missing signature' });
  }

  if (webhookSecret) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      logError(
        new ValidationError('Missing raw body'),
        { path: req.path, method: req.method }
      );
      return res.status(400).send('Missing raw body.');
    }

    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      logError(
        new AuthenticationError('Invalid webhook signature'),
        { path: req.path, method: req.method }
      );
      return res.status(401).json({ error: 'Unauthorized: invalid signature' });
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

    // Create session with retry logic and timeout
    let session;
    try {
      session = await retryWithBackoff(
        async () => {
          return await client.createSession({
            model: "gpt-4o",
            streaming: true,
            systemMessage: {
              mode: "replace",
              content: systemPrompt
            }
          });
        },
        {
          maxAttempts: 3,
          delayMs: 500,
          backoffMultiplier: 2,
          timeoutMs: 5000,
        },
        { path: req.path, method: req.method }
      );
    } catch (sessionError) {
      const err = sessionError as Error;
      logError(new ExternalServiceError(err.message, true, { path: req.path, method: req.method }), { path: req.path, method: req.method });
      return res.status(503).json({ error: 'Service temporarily unavailable' });
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

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});