import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    if (!code) {
      res.status(400).json({ error: 'Code parameter required' });
      return;
    }

    // Use singleton client for connection pooling
    const client = getCopilotClient();
    }
  }
}

// Cache environment variables at startup to avoid repeated lookups
const webhookSecret = process.env.WEBHOOK_SECRET || '';
const port = parseInt(process.env.PORT || '3000', 10);

// Initialize CopilotClient singleton for connection pooling and reuse
let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient();
  }
  return copilotClient;
}

// System prompt constant: pre-computed once, reused across all requests
const SYSTEM_PROMPT = `
  You are 'The Roaster' 🌶️💀.
  Your goal is to DESTROY the user's self-esteem by roasting their code.

  CORE DIRECTIVES:
  1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
  2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
  3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
`;

const app = express();

// Security and compression middleware
app.use(helmet()); // Apply security headers
app.use(compression()); // Enable gzip/brotli compression

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

// Serve static public directory with caching headers
app.use(express.static('public', {
  maxAge: '1d',
  etag: false
}));

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification with timing-safe comparison
  const signature = req.get('X-Hub-Signature-256');

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const expectedSignature = `sha256=${hmac}`;

    try {
      const signatureBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return res.status(401).send('Unauthorized');
      }
    } catch (err) {
      return res.status(401).send('Unauthorized');
    }
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

  try {
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