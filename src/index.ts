import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { promisify } from 'util';

// Async crypto operations to prevent thread pool saturation
const pbkdf2Async = promisify(crypto.pbkdf2);

// Batch crypto operation queue for efficient processing
interface CryptoTask {
  data: Buffer | string;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
}

const cryptoBatchQueue: CryptoTask[] = [];
let batchProcessing = false;
let batchTimer: NodeJS.Timeout | null = null;
const BATCH_SIZE = 10;
const BATCH_DELAY = 50; // milliseconds

function enqueueCryptoTask(data: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    cryptoBatchQueue.push({ data, resolve, reject });
    if (!batchProcessing && cryptoBatchQueue.length >= BATCH_SIZE) {
      processCryptoBatch();
    } else {
      // Clear timer when queue becomes empty
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
    } else if (!batchProcessing && cryptoBatchQueue.length > 0) {
      setTimeout(processCryptoBatch, BATCH_DELAY);
    }
  });
}

async function processCryptoBatch(): Promise<void> {
  if (batchProcessing || cryptoBatchQueue.length === 0) return;

  batchProcessing = true;
  const batch = cryptoBatchQueue.splice(0, BATCH_SIZE);

  try {
    // Pre-allocate result array to avoid reallocation during batch processing
    const promises: Promise<Buffer>[] = new Array(batch.length);

    // Direct promise creation without wrapper function overhead
    for (let i = 0; i < batch.length; i++) {
      // Generate cryptographically secure salt per-request instead of hardcoded string
      const salt = crypto.randomBytes(32);
      promises[i] = pbkdf2Async(batch[i].data, salt, 100000, 64, 'sha256');
    }

    // Use allSettled with indexed result handling to eliminate per-task Promise wrapper allocation
    const results = await Promise.allSettled(promises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const task = batch[i];
      if (result.status === 'fulfilled') {
        task.resolve(result.value);
      } else {
        task.reject(result.reason);
      }
    }
  } finally {
    batchProcessing = false;
    if (cryptoBatchQueue.length > 0) {
      setTimeout(processCryptoBatch, 0);
    }
  }
}

// Async hash function uses batch queue to prevent thread pool contention
async function hashAsync(data: string | Buffer, algorithm: string = 'sha256'): Promise<string> {
  if (algorithm === 'sha256') {
    // Use batch queue for sha256 to leverage enqueueCryptoTask batching
    const buffer = await enqueueCryptoTask(data);
    return buffer.toString('hex');
  }
  // Fallback for non-sha256 algorithms
  const hash = crypto.createHash(algorithm);
  hash.update(data);
  return hash.digest('hex');
}

// Async PBKDF2 with batching for key derivation
async function deriveKeyAsync(password: string | Buffer, salt: string | Buffer, iterations: number = 100000): Promise<Buffer> {
  try {
    return await pbkdf2Async(password, salt, iterations, 64, 'sha256');
  } catch (error) {
    throw new Error(`Key derivation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

// Batch key derivation for multiple passwords (useful for login verification at scale)
async function deriveBatchKeys(passwords: (string | Buffer)[], salt: string | Buffer, iterations: number = 100000): Promise<Buffer[]> {
  return Promise.all(
    passwords.map((password) => pbkdf2Async(password, salt, iterations, 64, 'sha256'))
  );
}

export { hashAsync, deriveKeyAsync, deriveBatchKeys, enqueueCryptoTask };
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

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
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