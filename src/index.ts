import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { promisify } from 'util';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { CopilotClient } from '@github/copilot-sdk';
import { streamJsonResponse } from './streaming-response';

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

// CopilotClient singleton pool to avoid repeated instantiation
class CopilotClientPool {
  private static instance: CopilotClient | null = null;
  private static initPromise: Promise<CopilotClient> | null = null;

  static async getInstance(): Promise<CopilotClient> {
    if (this.instance) {
      return this.instance;
    }
    
    if (this.initPromise) {
      return this.initPromise;
    }
    
    this.initPromise = (async () => {
      const client = new CopilotClient({
        token: process.env.GITHUB_TOKEN || '',
      });
      this.instance = client;
      return client;
    })();
    
    return this.initPromise;
  }

  static reset(): void {
    this.instance = null;
    this.initPromise = null;
  }
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Enable compression middleware for all responses
app.use(compression({
  level: 6, // Balanced compression level
  threshold: 1024, // Only compress responses > 1KB
}));

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Route handler error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    // Cache digest computation instead of Promise wrapper
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest) {
      return res.status(401).send('Unauthorized: Invalid signature.');
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Reuse singleton CopilotClient instance instead of per-request instantiation
  const client = await CopilotClientPool.getInstance();
  // Override token for this request if provided
  if (token) {
    client.setToken(token);
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

    // Validate input before creating session (fail fast)
    if (!prompt) {
      return res.status(400).json({ error: 'No prompt provided' });
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
  }
  // Do NOT close the pooled client instance - it stays alive for reuse
});

// Graceful shutdown handler to prevent stalled requests and drain pending async operations
const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// Enable graceful shutdown with timeout
process.on('SIGTERM', () => {
  console.log('SIGTERM received, starting graceful shutdown');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force exit after 30 seconds to prevent hanging requests
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});