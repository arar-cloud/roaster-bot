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

// Apply Helmet for security headers
app.use(helmet());

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
app.use((req, res, next) => {
  const origin = req.headers.origin as string;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-GitHub-Token, X-GitHub-Signature-256');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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

  if (!webhookSecret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'Missing raw body' });
  }

  try {
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const computedSignature = 'sha256=' + hmac.update(rawBody).digest('hex');
    const signatureBuffer = Buffer.from(signature);
    const computedBuffer = Buffer.from(computedSignature);

    if (signatureBuffer.length !== computedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, computedBuffer)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).json({ error: 'Missing X-GitHub-Token' });

  // Validate token format (basic checks)
  if (typeof token !== 'string' || token.length < 20 || token.length > 300 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  // Create per-token rate limiter
  const tokenLimiter = rateLimit({
    keyGenerator: () => token,
    windowMs: 15 * 60 * 1000,
    limit: 50,
    skip: false,
    handler: (req, res) => res.status(429).json({ error: 'Rate limit exceeded' })
  });

  try {
    await new Promise<void>((resolve, reject) => {
      tokenLimiter(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
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

    // Validate and sanitize userMessages
    let userMessages = req.body.messages;
    if (!Array.isArray(userMessages)) {
      userMessages = [];
    }

    // Enforce maximum message count
    if (userMessages.length > 50) {
      return res.status(400).json({ error: 'Too many messages' });
    }

    // Sanitize each message
    const sanitizedMessages = userMessages.map((msg: any) => {
      if (typeof msg !== 'object' || !msg || !('role' in msg) || !('content' in msg)) {
        throw new Error('Invalid message format');
      }
      const role = String(msg.role).toLowerCase();
      const content = String(msg.content);

      // Validate role
      if (!['user', 'assistant', 'system'].includes(role)) {
        throw new Error('Invalid message role');
      }

      // Enforce content length limit (5000 chars per message)
      if (content.length > 5000) {
        throw new Error('Message content too long');
      }

      return { role, content };
    });

    const lastMessage = sanitizedMessages.filter((m: any) => m.role === 'user').pop();
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