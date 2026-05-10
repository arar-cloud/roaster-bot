import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Configure HTTP timeout globally
http.globalAgent.timeout = 30000;
https.globalAgent.timeout = 30000;

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
    try {
      // Process message with timeout protection
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), 25000)
      );

      const result = await Promise.race([
        client.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: JSON.stringify(body) }],
        }),
        timeoutPromise
      ]);

      log.info('Message processed successfully');
      return res.status(200).json({ success: true, data: result });
    } catch (apiError) {
      log.error('API call failed', apiError);
      return res.status(502).json({ error: 'Upstream service error' });
    }
  } catch (error) {
    log.error('Unhandled error in /agent endpoint', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Apply Helmet middleware for security headers
app.use(helmet());

// Validate critical environment variables at startup
const requiredEnvVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Structured logging utility
const log = {
  info: (msg: string, data?: any) => console.log(`[INFO] ${msg}`, data || ''),
  error: (msg: string, data?: any) => console.error(`[ERROR] ${msg}`, data || ''),
  warn: (msg: string, data?: any) => console.warn(`[WARN] ${msg}`, data || '')
};

// Token format validation
const validateGitHubToken = (token: string): boolean => {
  if (!token || typeof token !== 'string') return false;
  return token.length > 0 && !token.includes(' ');
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Limit payload size to 10MB
app.use(express.json({ limit: '10mb',
  verify: (req: any, res, buf) => {
    const contentLength = parseInt(req.get('content-length') || '0', 10);
    if (contentLength > 10 * 1024 * 1024) {
      throw new Error('Payload too large');
    }
    // Webhook signature verification
    const signature = req.get('X-Hub-Signature-256');
    const secret = process.env.WEBHOOK_SECRET;
    if (signature && secret) {
      const hash = crypto.createHmac('sha256', secret).update(buf).digest('hex');
      if (signature !== `sha256=${hash}`) {
        throw new Error('Invalid webhook signature');
      }
    } else if (!secret) {
      throw new Error('WEBHOOK_SECRET not configured');
    }
    req.rawBody = buf.toString();
  }
}));

app.get('/', limiter, (req, res) => {
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
  try {
    const token = req.get('X-GitHub-Token');
    if (!token) {
      log.warn('Missing X-GitHub-Token header');
      return res.status(401).json({ error: 'Missing X-GitHub-Token' });
    }

    // Validate token format before use
    if (!validateGitHubToken(token)) {
      log.warn('Invalid X-GitHub-Token format');
      return res.status(401).json({ error: 'Invalid token format' });
    }

    // Initialize client with the user's token
    let client: CopilotClient;
    try {
      client = new CopilotClient({
        env: {
          GITHUB_TOKEN: token,
          ...process.env
        }
      });
      log.info('CopilotClient initialized successfully');
    } catch (initError) {
      log.error('CopilotClient initialization failed', initError);
      return res.status(503).json({ error: 'Service initialization failed' });
    }

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
    log.error('API call failed', error);
    if (!res.headersSent) res.status(500).json({ error: 'The roaster overheated.' });
  } finally {
    try {
      await client.stop();
    } catch (stopError) {
      log.error('Error stopping client', stopError);
    }
  }
  } catch (initError) {
    log.error('Request processing failed', initError);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});