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

// Payload size limit to prevent DoS
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

app.use(express.json({
  limit: MAX_PAYLOAD_SIZE,
  verify: (req: any, res, buf) => {
    // Enforce payload size limit
    if (buf.length > MAX_PAYLOAD_SIZE) {
      const err = new Error('Payload too large');
      (err as any).status = 413;
      throw err;
    }
    req.rawBody = buf.toString('utf8');
  }
}));

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
  // Webhook signature verification - MANDATORY validation
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook security not configured' });
  }

  if (!signature) {
    console.warn('Missing webhook signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
  const expectedSignature = `sha256=${digest}`;

  if (signature !== expectedSignature) {
    console.warn('Webhook signature verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) {
    console.warn('Missing X-GitHub-Token header');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Validate GitHub token format: should start with ghp_ (personal), ghu_ (user), or ghs_ (server)
  // GitHub tokens are typically 36+ characters and follow specific prefix patterns
  const tokenRegex = /^(ghp_|ghu_|ghs_)[a-zA-Z0-9_]{36,}$/;
  if (!tokenRegex.test(token)) {
    console.warn('Invalid GitHub token format');
    return res.status(401).json({ error: 'Unauthorized' });
  }

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