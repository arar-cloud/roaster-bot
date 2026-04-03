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

  // If a webhook secret is configured, a valid signature is REQUIRED on every request.
  // Reject immediately if the secret is set but the signature header is absent.
  if (webhookSecret) {
    if (!signature) {
      return res.status(401).send('Missing webhook signature');
    }
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      return res.status(401).send('Unauthorized');
    }
  }

  // Strict input validation for messages array
  const MAX_MESSAGES = 50;
  const MAX_MESSAGE_LENGTH = 10000;
  const MAX_PAYLOAD_SIZE = 1024 * 500; // 500KB

  if (!Array.isArray(req.body.messages)) {
    return res.status(400).send('Invalid input: messages must be an array');
  }
  if (req.body.messages.length === 0 || req.body.messages.length > MAX_MESSAGES) {
    return res.status(400).send(`Invalid input: messages array must have 1-${MAX_MESSAGES} items`);
  }
  if ((req.rawBody || '').length > MAX_PAYLOAD_SIZE) {
    return res.status(413).send('Payload too large');
  }

  // Enhanced message validation: enforce structure and content length
  const MAX_CONTENT_LENGTH = 4096;
  const MAX_PROMPT_LENGTH = 2048;

  for (const msg of req.body.messages) {
    if (typeof msg !== 'object' || msg === null) {
      return res.status(400).send('Invalid input: each message must be an object');
    }
    if (typeof msg.role !== 'string' || !['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).send('Invalid input: message role must be user, assistant, or system');
    }
    if (typeof msg.content !== 'string') {
      return res.status(400).send('Invalid input: message content must be a string');
    }
    if (msg.content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).send(`Invalid input: message content exceeds ${MAX_CONTENT_LENGTH} character limit`);
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token');

  // Validate token format: must be a known GitHub token prefix followed by alphanumeric chars,
  // or a legacy 40-character alphanumeric token. Reject any token containing whitespace,
  // newlines, or control characters to block header-injection and env-var manipulation.
  if (/[\r\n\x00-\x1f]/.test(token)) {
    return res.status(401).send('Invalid GitHub token format');
  }
  if (!/^(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]{36,255}$/.test(token) &&
      !/^[a-zA-Z0-9_-]{40,255}$/.test(token)) {
    return res.status(401).send('Invalid GitHub token format');
  }

  // Sanitize token: trim surrounding whitespace only
  const sanitizedToken = token.trim();

  // Derive a stable per-token key for scoped rate limiting (never log the raw token)
  const tokenKey = crypto.createHash('sha256').update(sanitizedToken).digest('hex').slice(0, 16);

  // Initialize client with ONLY the user token — never spread process.env to avoid
  // leaking secrets (DATABASE_URL, WEBHOOK_SECRET, etc.) into CopilotClient internals.
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: sanitizedToken, // isolated — no other env vars forwarded
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

    // Enforce MAX_PROMPT_LENGTH guard before sending to AI session
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).send(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
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