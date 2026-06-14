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
      validatedToken?: string;
    }
  }
}

// Input validation helpers
const validateGitHubToken = (token: string): boolean => {
  // GitHub tokens start with 'ghp_', 'ghu_', 'ghs_', or 'gho_'
  return /^(ghp_|ghu_|ghs_|gho_)[a-zA-Z0-9_]{36,255}$/.test(token);
};

const sanitizePrompt = (input: string): string => {
  // Remove excessive whitespace and limit length
  const sanitized = input.trim().slice(0, 2000);
  return sanitized;
};

const validateUserMessages = (messages: unknown): string[] => {
  if (!Array.isArray(messages)) {
    throw new Error('userMessages must be an array');
  }
  return messages.map(msg => {
    if (typeof msg !== 'string') {
      throw new Error('Each message must be a string');
    }
    return sanitizePrompt(msg);
  }).slice(0, 10); // Limit to 10 messages
};

const app = express();
const port = process.env.PORT || 3000;

// Validate webhook secret is configured
const webhookSecret = process.env.WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error('WEBHOOK_SECRET environment variable is required for security');
  process.exit(1);
}

// Apply helmet security headers first
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  xFrameOptions: { action: 'deny' },
  xContentTypeOptions: { nosniff: true },
}));

// Create key generator for per-token rate limiting
const keyGenerator = (req: Request) => {
  // Use GitHub token if provided, otherwise use IP address
  const token = req.headers['x-github-token'] as string;
  return token || req.ip || 'unknown';
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
});

app.use(express.json({
  limit: '1mb',
  verify: (req: Request, res, buf) => {
    (req as any).rawBody = buf.toString();
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

  if (!signature || !req.rawBody) {
    return res.status(401).json({ error: 'Missing signature or body' });
  }

  // Validate signature format before processing
  if (!signature.startsWith('sha256=') || signature.length !== 71) {
    return res.status(401).json({ error: 'Invalid signature format' });
  }

  try {
    // Compute expected digest using constant-time comparison
    const digest = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } catch (err) {
    // Prevent secret exposure in error logs
    console.error('Signature verification failed');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');
  
  // Validate GitHub token format
  if (!validateGitHubToken(token)) {
    return res.status(400).json({ error: 'Invalid GitHub token format' });
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

    // Validate and sanitize user messages
    const userMessages = req.body.messages || [];
    if (!Array.isArray(userMessages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    
    const lastMessage = userMessages.filter((m: any) => {
      if (typeof m !== 'object' || !m.role || !m.content) {
        return false;
      }
      return m.role === 'user';
    }).pop();
    
    const prompt = lastMessage ? sanitizePrompt(lastMessage.content) : "Roast me.";
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return res.status(400).json({ error: 'Invalid prompt content' });
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