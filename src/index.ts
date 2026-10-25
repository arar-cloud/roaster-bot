import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Constant-time string comparison to prevent timing attacks
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Validate GitHub token format
function isValidGitHubToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  // GitHub tokens typically start with 'gh' or 'ghs_' and are alphanumeric + underscore
  // Personal access tokens (classic) are 40 chars, new format varies but typically 36+ chars
  if (token.length < 20 || token.length > 255) return false;
  // Only allow alphanumeric, underscore, and hyphen
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return false;
  return true;
}

// Sanitize user input to prevent prompt injection
function sanitizeInput(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid input: must be a string');
  }
  // Limit input length to prevent excessively long prompts
  if (input.length > 4096) {
    throw new Error('Input exceeds maximum length of 4096 characters');
  }
  // Remove control characters and suspicious prompt directives
  let sanitized = input
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .replace(/\\n\s*system\s*:/gi, '') // Remove system directive attempts
    .replace(/\\n\s*admin\s*:/gi, '') // Remove admin directive attempts
    .trim();
  return sanitized;
}

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

// Apply security middleware
app.use(helmet());

// Configure CORS: only allow requests from same origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.get('origin') === process.env.ALLOWED_ORIGIN ? req.get('origin') : 'null');
  res.header('Access-Control-Allow-Methods', 'POST, GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-GitHub-Token');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
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
  limit: '10kb',
  verify: (req: any, res, buf) => {
    if (buf) {
      req.rawBody = buf.toString('utf8');
    }
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

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
    const expectedSignature = 'sha256=' + hmac.digest('hex');

    // Constant-time comparison to prevent timing attacks and reject unsigned payloads
    try {
      crypto.timingSafeEqual(
        Buffer.from(signature || ''),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      return res.status(401).json({ error: 'Webhook signature verification failed' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    return res.status(401).json({ error: 'Missing X-GitHub-Token' });
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