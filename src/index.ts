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

if (!process.env.WEBHOOK_SECRET) {
  console.error('FATAL: WEBHOOK_SECRET environment variable must be set');
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  keyGenerator: (req) => req.header('X-GitHub-Token') || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet());

app.use(express.json({
  limit: '1mb',
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

app.post('/agent', limiter, tokenLimiter, async (req: Request, res: Response) => {
  // CORS origin validation
  const origin = req.header('origin');
  if (origin && !origin.includes('github.com')) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error('Security: Missing request body for signature validation');
      return res.status(400).send('Invalid request.');
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    const signatureBuffer = Buffer.from(signature || '', 'utf8');
    const digestBuffer = Buffer.from(digest, 'utf8');
    
    let isValid = false;
    try {
      isValid = signatureBuffer.length === digestBuffer.length && crypto.timingSafeEqual(signatureBuffer, digestBuffer);
    } catch (e) {
      isValid = false;
    }

    if (!isValid) {
      console.warn(`[AUTH_FAIL] Webhook signature verification failed from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    console.info(`[AUTH_SUCCESS] Webhook validated from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
  }

  const token = req.get('X-GitHub-Token');
  if (!token) {
    console.warn(`[TOKEN_AUTH_FAIL] Missing authentication token from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
    return res.status(401).send('Unauthorized');
  }
  console.info(`[TOKEN_AUTH_SUCCESS] Token provided from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
  if (typeof token !== 'string' || token.length < 36 || token.length > 255 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    console.warn(`[TOKEN_INVALID] Invalid token format from IP: ${req.ip}, token_length: ${token?.length}, timestamp: ${new Date().toISOString()}`);
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  console.info(`[TOKEN_ACCEPTED] Valid token from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token
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

    const userMessages = (req.body.messages || [])
      .filter((msg: any) => typeof msg === 'object' && msg !== null)
      .map((msg: any) => ({
        ...msg,
        content: typeof msg.content === 'string' ? msg.content.substring(0, 5000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') : msg.content
      }));
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
    console.info(`[AGENT_SUCCESS] Request completed for token from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[AGENT_ERROR] Request failed from IP: ${req.ip}, error: ${errorMessage}, timestamp: ${new Date().toISOString()}`);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});