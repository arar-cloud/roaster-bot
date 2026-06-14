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

// Simple in-memory nonce storage (in production, use Redis with TTL)
const nonceStore = new Map<string, { timestamp: number; used: boolean }>();

// Clean up expired nonces every minute
setInterval(() => {
  const now = Date.now();
  const NONCE_TTL = 5 * 60 * 1000; // 5 minutes
  for (const [nonce, data] of nonceStore.entries()) {
    if (now - data.timestamp > NONCE_TTL) {
      nonceStore.delete(nonce);
    }
  }
}, 60000);

// Apply helmet security headers middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiter to all routes
app.use(limiter);

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

app.post('/agent', async (req: Request, res: Response) => {
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

  // Validate CSRF token to prevent cross-site request forgery
  const csrfToken = req.get('X-CSRF-Token');
  if (!csrfToken) {
    console.warn('Missing CSRF token header');
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  // CSRF token must be at least 32 bytes hex-encoded (64 chars) or similar secure format
  const csrfTokenRegex = /^[a-f0-9]{64}$/i;
  if (!csrfTokenRegex.test(csrfToken)) {
    console.warn('Invalid CSRF token format');
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Validate nonce to prevent replay attacks
  const clientNonce = req.get('X-Nonce');
  if (!clientNonce) {
    console.warn('Missing nonce header for session validation');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nonceData = nonceStore.get(clientNonce);
  if (!nonceData) {
    console.warn('Invalid or expired nonce provided');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (nonceData.used) {
    console.warn('Nonce already used - replay attack detected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Mark nonce as used
  nonceData.used = true;

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
    let prompt = lastMessage ? lastMessage.content : "Roast me.";
    
    // Validate prompt is a string
    if (typeof prompt !== 'string') {
      console.warn('Prompt must be a string');
      return res.status(400).json({ error: 'Bad request' });
    }
    
    // Enforce maximum message length (prevent DoS via huge prompts)
    const MAX_MESSAGE_LENGTH = 10000;
    if (prompt.length > MAX_MESSAGE_LENGTH) {
      console.warn(`Prompt exceeds maximum length of ${MAX_MESSAGE_LENGTH}`);
      return res.status(400).json({ error: 'Bad request' });
    }
    
    // Sanitize: trim whitespace and remove null bytes
    prompt = prompt.trim().replace(/\0/g, '');
    
    // Ensure prompt is not empty after sanitization
    if (prompt.length === 0) {
      console.warn('Prompt is empty after sanitization');
      return res.status(400).json({ error: 'Bad request' });
    }

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