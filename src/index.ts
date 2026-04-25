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

// Apply security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  frameguard: { action: 'deny' },
  xssFilter: true,
  noSniff: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

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

  // Verify webhook signature with HMAC-SHA256
  if (!webhookSecret) {
    return res.status(500).json({ error: 'WEBHOOK_SECRET not configured' });
  }

  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const computed = `sha256=${hmac.update(rawBody).digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const token = req.get('X-GitHub-Token');
  
  // Validate GitHub token presence and format
  if (!token) {
    return res.status(401).json({ error: 'Missing GitHub token' });
  }
  
  if (typeof token !== 'string' || token.length === 0) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  // Initialize client with the user's token
  // Do not log token or include in error messages
  let client;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
  } catch (error) {
    console.error('Failed to initialize Copilot client (token error)');
    return res.status(500).json({ error: 'Authentication failed' });
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

    // Validate userMessages input
    if (!Array.isArray(userMessages)) {
      return res.status(400).json({ error: 'userMessages must be an array' });
    }

    if (userMessages.length === 0 || userMessages.length > 100) {
      return res.status(400).json({ error: 'userMessages must contain 1-100 items' });
    }

    for (const msg of userMessages) {
      if (typeof msg !== 'object' || msg === null) {
        return res.status(400).json({ error: 'Each message must be an object' });
      }
      if (typeof msg.role !== 'string' || !['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'Invalid message role' });
      }
      if (typeof msg.content !== 'string' || msg.content.length === 0 || msg.content.length > 4096) {
        return res.status(400).json({ error: 'Message content must be 1-4096 characters' });
      }
    }

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
    console.error('Error during roasting session (error details suppressed)');
    if (!res.headersSent) res.status(500).json({ error: 'The roaster overheated.' });
  } finally {
    try {
      await client.stop();
    } catch (stopError) {
      console.error('Error stopping client (error details suppressed)');
    }
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});