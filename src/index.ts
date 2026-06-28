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

// Initialize singleton CopilotClient once at module load
let copilotClient: CopilotClient | null = null;
const getCopilotClient = (): CopilotClient => {
  if (!copilotClient) {
    copilotClient = new CopilotClient();
  }
  return copilotClient;
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Pre-compute HMAC digest at startup to avoid blocking on every request
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB limit
let precomputedHmac: string | null = null;

if (WEBHOOK_SECRET) {
  // Pre-compute a digest template at startup (non-blocking module init)
  precomputedHmac = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update('')
    .digest('hex');
}

app.use(express.json({
  verify: (req: any, res, buf) => {
    // Validate Content-Length before buffering to prevent memory bloat
    const contentLength = parseInt(req.get('content-length') || '0', 10);
    if (contentLength > MAX_PAYLOAD_SIZE) {
      throw new Error(`Payload too large: ${contentLength} bytes exceeds ${MAX_PAYLOAD_SIZE} byte limit`);
    }
    req.rawBody = buf.toString();
  }
}));

// Serve static files from public directory
app.use(express.static('public'));

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    try {
      const signatureBuffer = Buffer.from(signature);
      const digestBuffer = Buffer.from(digest);
      if (!crypto.timingSafeEqual(signatureBuffer, digestBuffer)) {
        return res.status(401).send('Invalid signature.');
      }
    } catch {
      return res.status(401).send('Invalid signature.');
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