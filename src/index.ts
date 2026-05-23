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
      isWebhookValid?: boolean;
    }
  }
}

// System prompt constant (computed once, not per-request)
const SYSTEM_PROMPT = `
  You are 'The Roaster' 🌶️💀.
  Your goal is to DESTROY the user's self-esteem by roasting their code.

  CORE DIRECTIVES:
  1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
  2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
  3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
`;

// Singleton CopilotClient factory
let copilotClientInstance: CopilotClient | null = null;

const getCopilotClient = (): CopilotClient => {
  if (!copilotClientInstance) {
    const token = process.env.GITHUB_TOKEN || '';
    copilotClientInstance = new CopilotClient({
      token: token,
    });
  }
  return copilotClientInstance;
};

// Async HMAC verification middleware
const verifyWebhookSignature = async (req: any, res: any, next: any) => {
  try {
    const signature = req.headers['x-github-hook-signature-256'] as string;
    if (!signature) {
      req.isWebhookValid = false;
      return next();
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.rawBody || '');
    const hash = 'sha256=' + hmac.digest('hex');

    req.isWebhookValid = crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(signature)
    );
  } catch (error) {
    req.isWebhookValid = false;
  }
  next();
};

const app = express();
const port = process.env.PORT || 3000;

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

app.use(express.static('public'));

app.post('/webhook', verifyWebhookSignature, async (req: Request, res: Response) => {
  if (!req.isWebhookValid) {
    res.status(401).send('Invalid signature');
    return;
  }
});

app.post('/agent', limiter, async (req: Request, res: Response) => {

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  const client = getCopilotClient();

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