import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { timingSafeEqual } from 'crypto';

// Global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  try {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Defer exit to allow pending operations to complete
    setImmediate(() => {
      process.exit(1);
    });
  } catch (err) {
    console.error('Failed to log unhandled rejection:', err);
    setImmediate(() => {
      process.exit(1);
    });
  }
});

// Global uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Validate required environment variables
if (!process.env.GITHUB_WEBHOOK_SECRET) {
  console.error('FATAL: GITHUB_WEBHOOK_SECRET is not set. Set this environment variable to enable webhook security.');
  process.exit(1);
}

if (!process.env.PORT) {
  console.warn('PORT not set, defaulting to 3000');
  process.env.PORT = '3000';
}

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// GitHub webhook signature verification middleware
const verifyGitHubSignature = (req: any, res: Response, next: any) => {
  const signature = req.get('X-Hub-Signature-256');
  const payload = req.rawBody;

  if (!signature || !payload || typeof signature !== 'string' || typeof payload !== 'string') {
    console.warn('Missing or invalid GitHub signature/payload');
    return res.status(401).json({ error: 'Missing signature or payload' });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (!signature.startsWith('sha256=')) {
    console.warn('Invalid signature format: missing sha256= prefix');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expected = `sha256=${hash}`;

  try {
    // Fixed: Extract expected hash and use timing-safe comparison with fixed-length buffers
    const receivedHash = signature.slice(7); // Remove 'sha256=' prefix
    const expectedHash = hash;
    // Ensure both buffers are exactly 64 bytes (sha256 hex digest length)
    if (receivedHash.length !== 64 || expectedHash.length !== 64) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const receivedBuf = Buffer.from(receivedHash, 'hex');
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    timingSafeEqual(receivedBuf, expectedBuf);
  } catch (err) {
    console.warn('Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

const app = express();
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});

app.use(limiter);
app.use(express.json({
  verify: (req: any, res, buf, encoding) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}));

app.post('/webhook', limiter, verifyGitHubSignature, async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('Webhook received:', payload?.action);
    if (!copilotClient) {
      return res.status(503).json({ error: 'Copilot client not initialized' });
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/github-webhook', verifyGitHubSignature, async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('Webhook received:', payload.action);
    const prNumber = payload.pull_request?.number;
    if (!prNumber) {
      res.status(400).json({ error: 'PR number not found' });
      return;
    }
    const client = new CopilotClient({ token: process.env.GITHUB_TOKEN! });
    const review = await client.getReview(payload.repository.full_name, prNumber);
    res.json({ review });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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

app.post('/agent', limiter, verifyGitHubSignature, async (req: Request, res: Response) => {

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');
  // Validate token format: GitHub tokens are typically 40+ alphanumeric characters
  if (!/^[a-zA-Z0-9_-]{40,}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid X-GitHub-Token format.' });
  }

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });

  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || !body.messages) {
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.

      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    const userMessages = body.messages || [];
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

    // Explicit cleanup: destroy session after use to prevent token leaks
    res.on('finish', () => {
      if (session) {
        session.dispose?.();
      }
    });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("Internal server error");
  } finally {
    await client.stop();
  }
});

let copilotClient: CopilotClient | null = null;
try {
  copilotClient = new CopilotClient({
    token: process.env.GITHUB_TOKEN || '',
  });
} catch (error) {
  console.error('Failed to initialize GitHub Copilot client:', error);
}

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});