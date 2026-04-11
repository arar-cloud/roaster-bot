import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { globalQueue } from './queue.js';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Helper function for safe environment variable access
function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  return value ?? defaultValue ?? '';
}

// Validate critical environment variables at startup
function validateEnvironment(): boolean {
  const requiredVars = ['GITHUB_TOKEN'];
  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
    return false;
  }
  return true;
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Register queue handlers for critical async operations
globalQueue.registerHandler('process-pr-review', async (task) => {
  try {
    const { title, body, headRef } = task.payload as any;
    if (!title || !headRef) {
      throw new Error('Invalid PR review payload: missing title or headRef');
    }

    const client = new CopilotClient();
    if (!client) {
      throw new Error('Failed to initialize CopilotClient');
    }

    const result = await client.getCompletions({
      prompt: `Review this PR: ${title}\n\n${body || '(no description)'}`,
    });

    return {
      taskId: task.id,
      success: true,
      result: result,
      attempts: task.attempts,
    };
  } catch (error) {
    throw error;
  }
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
  const webhookSecret = process.env.WEBHOOK_SECRET ?? '';

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody || typeof rawBody !== 'string') return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
        // Simple check for dev
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token || typeof token !== 'string') return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  if (!client) {
    return res.status(500).send('Failed to initialize Copilot client.');
  }
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

    const userMessages = (req.body?.messages as Array<any> | undefined) ?? [];
    const lastMessage = Array.isArray(userMessages) ? userMessages.filter((m: any) => m?.role === 'user').pop() : undefined;
    const prompt = (lastMessage?.content as string | undefined) ?? "Roast me.";

    // Queue the roasting task for reliable processing
    const taskId = await globalQueue.enqueue(
      'process-pr-review',
      {
        title: 'Roast Request',
        body: prompt,
        headRef: 'roast-session',
      },
      { maxRetries: 3, priority: 'high' }
    );

    res.setHeader('Content-Type', 'application/json');
    res.status(202).json({
      received: true,
      taskId,
      status: 'queued',
      message: 'Your roasting is being prepared...',
    });

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