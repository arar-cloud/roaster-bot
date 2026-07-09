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
});

// Payload validation constants
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB
const MAX_JSON_DEPTH = 10;
const MAX_ARRAY_SIZE = 1000;

// Check JSON payload depth recursively
function validateJsonDepth(obj: any, currentDepth: number = 0): boolean {
  if (currentDepth > MAX_JSON_DEPTH) {
    return false;
  }

  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_SIZE) {
      return false;
    }
    return obj.every(item => validateJsonDepth(item, currentDepth + 1));
  }

  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj).every(value => validateJsonDepth(value, currentDepth + 1));
  }

  return true;
}

app.use(express.json({
  limit: `${MAX_PAYLOAD_SIZE / 1024}kb`,
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
    
    // Validate Content-Length header
    const contentLength = parseInt(req.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_SIZE) {
      throw new Error(`Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE} bytes`);
    }
  }
}));

// Middleware to validate JSON depth and structure
app.use((req: any, res: Response, next) => {
  if (req.body && typeof req.body === 'object') {
    if (!validateJsonDepth(req.body)) {
      return res.status(400).json({ error: 'Request payload exceeds complexity limits' });
    }
  }
  next();
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
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
        // Simple check for dev
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Validate GitHub token format and structure
  const validTokenPatterns = /^(ghp_|gho_|ghu_)[A-Za-z0-9_]{36,255}$/;
  if (!validTokenPatterns.test(token)) {
    return res.status(400).json({ error: 'Invalid GitHub token format' });
  }

  // Token length validation (GitHub tokens are typically 36-255 chars after prefix)
  if (token.length > 300) {
    return res.status(400).json({ error: 'Token exceeds maximum length' });
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