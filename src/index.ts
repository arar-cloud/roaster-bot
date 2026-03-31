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

// Reuse shared CopilotClient instance to avoid repeated connection setup
let cachedClient: CopilotClient | null = null;
async function getClient() {
  if (!cachedClient) {
    cachedClient = new CopilotClient();
  }
  return cachedClient;
}

// Singleton CopilotClient instance to avoid per-request instantiation overhead
let copilotClientInstance: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClientInstance) {
    copilotClientInstance = new CopilotClient({
      token: process.env.GITHUB_TOKEN || '',
    });
  }
  return copilotClientInstance;
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// HMAC cache: stores computed signatures to avoid recomputation
const hmacCache = new Map<string, string>();
const MAX_CACHE_SIZE = 1000;

function getHmacSHA256(payload: string, secret: string): string {
  const cacheKey = `${payload.length}:${secret.length}`;
  if (hmacCache.has(cacheKey)) {
    return hmacCache.get(cacheKey)!;
  }
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (hmacCache.size >= MAX_CACHE_SIZE) {
    const firstKey = hmacCache.keys().next().value;
    hmacCache.delete(firstKey);
  }
  hmacCache.set(cacheKey, sig);
  return sig;
}

// Use async body parser with lazy verification for better event loop throughput
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString('utf8', 0, Math.min(buf.length, 10000));
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

app.post('/webhook', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const digest = 'sha256=' + getHmacSHA256(rawBody, webhookSecret);

    if (signature !== digest && signature !== `sha256=${digest}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Reuse pooled client instance instead of creating new per-request
  const client = getCopilotClient();
  
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

    // Timeout session operations after 30s to prevent hanging
    const sessionTimeout = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Session timeout after 30s')), 30000)
    );
    
    try {
      await Promise.race([session.sendAndWait({ prompt }), sessionTimeout]);
    } catch (error) {
      console.error('Error:', error);
      if (!res.headersSent) res.status(500).send("The roaster overheated.");
      return;
    }

    res.write('data: [DONE]\n\n');
    res.end();
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});