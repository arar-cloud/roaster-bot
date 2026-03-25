import 'dotenv/config';
import express, { Request, Response } from 'express';

// Validate required environment variables at startup
const requiredEnvVars = ['GITHUB_WEBHOOK_SECRET', 'COPILOT_API_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Additional validation: log warnings for deprecation notices
console.log('Environment validation passed. Required variables initialized.');
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
const requiredEnvVars = ['GITHUB_WEBHOOK_SECRET', 'COPILOT_API_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}. Server cannot start.`);
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;



const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
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

app.post('/webhook', async (req: Request, res: Response) => {
  // Security: Validate GitHub webhook signature
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // Webhook signature validation is REQUIRED
  if (!webhookSecret) {
    console.error('ERROR: Webhook received but GITHUB_WEBHOOK_SECRET is not set');
    return res.status(403).json({ error: 'Webhook secret not configured' });
  }

  if (!signature) {
    console.error('ERROR: Webhook missing x-hub-signature-256 header');
    return res.status(403).json({ error: 'Invalid webhook signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  try {
    // Use timing-safe comparison to prevent timing attacks
    const signatureBuffer = Buffer.from(signature);
    const digestBuffer = Buffer.from(digest);
    if (signatureBuffer.length !== digestBuffer.length) {
      throw new Error('Signature length mismatch');
    }
    const isValid = crypto.timingSafeEqual(signatureBuffer, digestBuffer);
    if (!isValid) {
      throw new Error('Signature verification failed');
    }
  } catch (err) {
    console.error('ERROR: Webhook signature verification failed - unauthorized access attempt');
    return res.status(401).json({ error: 'Unauthorized' });
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

  // Validate webhook payload structure
  if (typeof req.body !== 'object' || !req.body) {
    console.warn('Webhook payload is not a valid object');
    return res.status(400).json({ error: 'Invalid payload format' });
  }

  const payload = req.body;
  if (!payload.repository || !payload.pull_request) {
    console.warn('Webhook payload missing expected fields, skipping processing');
    return res.status(200).json({ message: 'Webhook received but skipped' });
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