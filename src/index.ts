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

// Pre-warm environment variables at startup to avoid repeated lookups on every request
const ENV_CACHE = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || ''
};

const app = express();
const port = ENV_CACHE.PORT;

// CopilotClient cache with TTL to avoid repeated initialization
class ClientCache {
  private cache = new Map<string, { client: CopilotClient; timestamp: number }>();
  private readonly TTL = 3600000; // 1 hour
  private readonly MAX_SIZE = 50; // Max 50 cached clients

  get(token: string): CopilotClient | null {
    const entry = this.cache.get(token);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(token);
      return null;
    }

    return entry.client;
  }

  set(token: string, client: CopilotClient): void {
    // Simple eviction: remove oldest entry if cache is full
    if (this.cache.size >= this.MAX_SIZE) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(token, { client, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

const clientCache = new ClientCache();

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
  const webhookSecret = ENV_CACHE.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      // Use timing-safe comparison to prevent timing attacks
      const expectedHmac = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      const digest = 'sha256=' + expectedHmac;
      
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'utf8'),
        Buffer.from(digest, 'utf8')
      );
      
      if (!isValid) {
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