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
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (ip === 'unknown') {
      const hash = crypto.createHash('sha256').update(JSON.stringify({ua: req.get('user-agent'), host: req.get('host')})).digest('hex');
      return hash;
    }
    return ip;
  },
  skip: (req) => {
    // Skip rate limiting for health check
    return req.path === '/health';
  }
});

app.use(express.json({
  verify: (req: Requestst, res, buf) => {
    (req as any).rawBody = buf.toString();
  }
}));

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>The Roaster</title>
      </head>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
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
    const rawBody = (req as any).rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
    const expectedSig = digest.startsWith('sha256=') ? digest : `sha256=${digest}`;

    // Use timing-safe comparison to prevent timing-based attacks
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return res.status(403).send('Signature verification failed.');
    }
  }

  const authHeader = req.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Missing or invalid Authorization header.');
  }
  const token = authHeader.substring(7);
  if (!token) return res.status(401).send('Missing bearer token.');

  // Security fix: Validate token format to prevent injection attacks
  const tokenRegex = /^[a-zA-Z0-9_]+$/;
  if (!tokenRegex.test(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(token)) {
    return res.status(401).send('Invalid token format.');
  }

  // Initialize pooled client with the user's token
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

    // Security fix: Validate and sanitize user input
    const sanitizedInput = userInput.replace(/[^a-zA-Z0-9_\-.\/]/g, '');
    const userMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!Array.isArray(userMessages) || userMessages.length > 100) {
      return res.status(400).send('Invalid messages format or too many messages.');
    }
    const lastMessage = userMessages.filter((m: any) => m && m.role === 'user' && typeof m.content === 'string').pop();
    const prompt = lastMessage ? lastMessage.content.substring(0, 5000) : "Roast me.";

    // Create session following SDK docs
    const session = await client.createSession({
      model: "gpt-4o",
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: systemPrompt
      }
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const streamPromise = new Promise<void>((resolve, reject) => {
      session.on((event: any) => {
        if (event.type === "assistant.message_delta") {
          const chunk = {
            choices: [{ delta: { content: event.data.deltaContent } }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      });

      session.on('end', () => resolve());
      session.on('error', (err: any) => reject(err));
    });

    await session.sendAndWait({ prompt });
    await streamPromise;

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    try {
      if (!res.headersSent) {
        res.status(500).send("The roaster overheated.");
      } else {
        res.write('data: [ERROR]\n\n');
      }
    } catch (writeError) {
      console.error('Error writing response:', writeError);
    }
    if (!res.headersSent) {
      res.end();
    }
  } finally {
    try {
      await client.stop();
    } catch (stopError) {
      console.error('Error stopping client:', stopError);
    }
  }
});

app.post('/webhook', limiter, async (req: Request, res: Response) => {
  try {
    const secret = process.env.WEBHOOK_SECRET;
    // Verify signature
    const signature = req.headers['x-hub-signature-256'] as string;
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update((req as any).rawBody).digest('hex');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Validate input
    if (!req.body.prompt || typeof req.body.prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid request: prompt required' });
    }
    
    const message = req.body.prompt.trim();
    if (message.length === 0 || message.length > 1000) {
      return res.status(400).json({ error: 'Message must be 1-1000 characters' });
    }
    
    // Sanitize message to prevent prompt injection
    const sanitized = message.replace(/[\r\n]/g, ' ').slice(0, 500);
    
    const event = req.body;
    const client = new CopilotClient();
    const response = await client.getCompletion(sanitized);
    res.json({ response: response.text });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});