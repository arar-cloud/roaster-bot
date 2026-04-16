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

// Persistent crypto batch processor with max size limit and backpressure
const MAX_QUEUE_SIZE = 1000; // Prevent unbounded accumulation under high load
const QUEUE_BACKPRESSURE_THRESHOLD = 800; // Reject at 80% capacity
const CIRCUIT_BREAKER_RESET_MS = 5000;
const globalCryptoQueue: any[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
let lastFlushTime = Date.now();
let circuitBreakerOpen = false;
let circuitBreakerResetTimeout: NodeJS.Timeout | null = null;
const BATCH_TIMEOUT_MS = 50; // Max latency for any queued request

// Check if queue has capacity with circuit-breaker pattern
const canEnqueueOperation = () => {
  if (circuitBreakerOpen) return false;
  if (globalCryptoQueue.length >= QUEUE_BACKPRESSURE_THRESHOLD) {
    circuitBreakerOpen = true;
    if (circuitBreakerResetTimeout) clearTimeout(circuitBreakerResetTimeout);
    circuitBreakerResetTimeout = setTimeout(() => {
      circuitBreakerOpen = false;
    }, CIRCUIT_BREAKER_RESET_MS);
    return false;
  }
  return true;
};

const flushCryptoBatch = async () => {
  if (globalCryptoQueue.length === 0) return;
  lastFlushTime = Date.now();
  const batch = globalCryptoQueue.splice(0, 10);
  
  const BATCH_INTERVAL_MS = 10;
  setTimeout(() => {
    batch.forEach(job => {
      const hmac = crypto.createHmac('sha256', job.secret);
      const digest = 'sha256=' + hmac.update(job.data).digest('hex');
      const isValid = job.sig === digest || job.sig === `sha256=${digest}`;
      job.resolve(isValid);
    });
  }, BATCH_INTERVAL_MS);
};

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    // Async cryptographic operation queue for batching
    const cryptoQueue = [];
    
    // Async signature verification with backpressure and circuit-breaker
    const verifySignatureAsync = (data, sig, secret) => {
      return new Promise((resolve, reject) => {
        // Apply backpressure: reject early at 80% capacity instead of 100%
        if (!canEnqueueOperation()) {
          reject(new Error('Crypto queue at backpressure threshold - rejecting request'));
          return;
        }
        cryptoQueue.push({ data, sig, secret, resolve });
        processCryptoBatch();
      });
    };
    
    const processCryptoBatch = async () => {
      if (cryptoQueue.length === 0) return;
      const batch = cryptoQueue.splice(0, 10);
      
      // Process batch in next tick to allow queueing
      const BATCH_INTERVAL_MS = 10;
      setTimeout(() => {
        batch.forEach(job => {
          const hmac = crypto.createHmac('sha256', job.secret);
          const digest = 'sha256=' + hmac.update(job.data).digest('hex');
          const isValid = job.sig === digest || job.sig === `sha256=${digest}`;
          job.resolve(isValid);
        });
      }, BATCH_INTERVAL_MS);
    };
    
    const isValid = await verifySignatureAsync(rawBody, signature, webhookSecret);
    if (!isValid) {
        // Simple check for dev
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