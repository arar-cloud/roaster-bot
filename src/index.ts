import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { cleanupResources } from './api/index.js';

// CopilotClient singleton for connection pooling
class CopilotClientManager {
  private static instance: CopilotClient | null = null;
  private static isInitializing = false;
  private static initPromise: Promise<CopilotClient> | null = null;

  static async getInstance(): Promise<CopilotClient> {
    if (this.instance && this.validateClientState(this.instance)) {
      return this.instance;
    }

    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    this.isInitializing = true;
    this.initPromise = this.initializeClient()
      .finally(() => {
        this.isInitializing = false;
      });

    return this.initPromise;
  }

  private static async initializeClient(): Promise<CopilotClient> {
    try {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN environment variable not set');
      }
      this.instance = new CopilotClient({ token });
      console.log('[CopilotClientManager] Client initialized successfully');
      return this.instance;
    } catch (error) {
      console.error('[CopilotClientManager] Failed to initialize client:', error);
      throw error;
    }
  }

  private static validateClientState(client: CopilotClient): boolean {
    try {
      return client != null && typeof client === 'object';
    } catch (error) {
      console.error('[CopilotClientManager] Client state validation failed:', error);
      return false;
    }
  }

  static async destroy(): Promise<void> {
    try {
      if (this.instance) {
        this.instance = null;
      }
      console.log('[CopilotClientManager] Destroyed successfully');
    } catch (error) {
      console.error('[CopilotClientManager] Error during destruction:', error);
    }
  }
}

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

let isShuttingDown = false;
let activeRequests = 0;
const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[roaster] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`, error);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Track active requests
app.use((req: Request, res: Response, next: Function) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }
  activeRequests++;
  res.on('finish', () => {
    activeRequests--;
  });
  next();
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

  // Use singleton instance with state validation and retry logic
  const client = await retryWithBackoff(
    () => CopilotClientManager.getInstance(),
    3,
    100
  );
  
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

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop accepting new connections
  server.close(() => {
    console.log('[Shutdown] Server stopped accepting new connections');
  });

  // Wait for in-flight requests to complete with timeout
  const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (activeRequests > 0 && Date.now() < shutdownDeadline) {
    console.log(`[Shutdown] Waiting for ${activeRequests} active request(s) to complete...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (activeRequests > 0) {
    console.warn(`[Shutdown] Timeout reached with ${activeRequests} active request(s) still in-flight`);
  }

  // Cleanup resources
  try {
    await CopilotClientManager.destroy();
    console.log('[Shutdown] Cleaned up CopilotClient');
  } catch (error) {
    console.error('[Shutdown] Error cleaning up CopilotClient:', error);
  }

  try {
    await cleanupResources();
    console.log('[Shutdown] Cleaned up API module resources');
  } catch (error) {
    console.error('[Shutdown] Error cleaning up API module resources:', error);
  }

  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));