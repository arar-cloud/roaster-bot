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

// Security headers via helmet: sets X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy, and a restrictive CSP.
app.use(
  (require('helmet') as typeof import('helmet').default)({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: true,
  })
);

// CORS: reject cross-origin requests unless the Origin is explicitly allowlisted.
// Set ALLOWED_ORIGINS=https://example.com,https://other.com in your environment.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use((req: Request, res: Response, next) => {
  const origin = req.get('origin');
  if (origin !== undefined) {
    if (ALLOWED_ORIGINS.length === 0 || !ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).send('CORS: origin not allowed');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GitHub-Token, X-Hub-Signature-256');
    res.status(204).end();
    return;
  }
  next();
});

// Global limiter: coarse protection against unauthenticated burst traffic.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30,               // tightened from 100
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-token limiter: applied after token validation using the hashed token as key.
// Prevents a single valid token from exhausting backend capacity.
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const t = req.get('X-GitHub-Token') ?? '';
    return crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
  },
  skip: (req: Request) => !req.get('X-GitHub-Token'), // only applies after a token is present
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
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

app.post('/agent', agentLimiter, limiter, tokenLimiter, async (req: Request, res: Response) => {
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
    hmac.update(rawBody);
    const expected = `sha256=${hmac.digest('hex')}`;
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    try {
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid signature' });
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
  if (!token || typeof token !== 'string') {
    return res.status(401).send('Missing X-GitHub-Token');
  }

  // Validate token format: GitHub tokens are alphanumeric with underscores/hyphens,
  // typically 20–255 characters. Reject anything outside this envelope.
  const TOKEN_RE = /^[A-Za-z0-9_\-]{20,255}$/;
  if (!TOKEN_RE.test(token)) {
    return res.status(401).send('Invalid GitHub token format');
  }

  // Additional security: reject any token containing control characters or whitespace
  // to block header-injection and env-var manipulation.
  if (/[\r\n\x00-\x1f\s]/.test(token)) {
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
      GITHUB_TOKEN: sanitizedToken
    }
  });

  try {
    // System prompt: static directive is separated from user content by explicit boundary.
    // Never interpolate raw user content into the static directive section.
    // Boundary marker: END_SYSTEM_DIRECTIVE_START_USER_CONTENT below prevents injection attacks.
    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.

      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    // Sanitize last user message: strip control characters and truncate to prevent
    // prompt injection from overriding system directives or exfiltrating data.
    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const rawUserMessage = lastMessage ? lastMessage.content : "Roast me.";
    const prompt = rawUserMessage
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // strip non-printable control chars
      .slice(0, MAX_PROMPT_LENGTH);

    // Enforce MAX_PROMPT_LENGTH guard before sending to AI session
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).send(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
    }

    // Create session following SDK docs
    let session;
    try {
      session = await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
    } catch (sessionErr) {
      const msg = sessionErr instanceof Error ? sessionErr.message : 'Session creation failed';
      return res.status(500).json({ error: msg });
    }

    const STREAM_TIMEOUT_MS = 30_000;   // 30 seconds max stream duration
    const MAX_STREAM_BYTES = 524_288;   // 512 KB max total response size
    let streamBytes = 0;
    let streamTimedOut = false;

    // Abort stream if client disappears mid-response to free session resources immediately.
    const onClientClose = () => {
      if (session) {
        try { (session as any).destroy?.(); } catch (_) { /* best-effort */ }
      }
    };
    req.on('close', onClientClose);

    // Hard deadline: kill stream after STREAM_TIMEOUT_MS regardless of progress.
    const streamTimer = setTimeout(() => {
      streamTimedOut = true;
      res.write('data: [STREAM_TIMEOUT]\n\n');
      res.end();
    }, STREAM_TIMEOUT_MS);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    session.on('message', (event: any) => {
      if (event.type === "assistant.message_delta") {
        const chunk = {
          choices: [{ delta: { content: event.data.deltaContent } }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    });

    try {
      await session.sendAndWait({ prompt });
      res.write('data: [DONE]\n\n');
    } catch (streamErr) {
      const msg = streamErr instanceof Error ? streamErr.message : 'Stream error';
      res.write(`data: {"error":"${msg}"}\n\n`);
    } finally {
      res.end();
    }

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    clearTimeout(streamTimer);
    req.off('close', onClientClose);
    if (streamTimedOut !== true) await client.stop();
  }
});

// Catch malformed JSON from express.json() — must be a 4-argument Express error handler.
// Returns a plain 400 without stack trace to prevent information disclosure.
app.use((err: any, req: Request, res: Response, next: any) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).send('Malformed JSON in request body');
    return;
  }
  // Pass other errors to the default handler without leaking internals.
  next(err);
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});