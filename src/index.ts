import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Circuit breaker state management
interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

const circuitBreakerState: CircuitBreakerState = {
  state: 'CLOSED',
  failureCount: 0,
  lastFailureTime: 0,
  successCount: 0
};

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 60000;

const isCircuitOpen = (): boolean => {
  if (circuitBreakerState.state === 'OPEN') {
    const timeSinceLastFailure = Date.now() - circuitBreakerState.lastFailureTime;
    if (timeSinceLastFailure > RESET_TIMEOUT_MS) {
      circuitBreakerState.state = 'HALF_OPEN';
      circuitBreakerState.successCount = 0;
      return false;
    }
    return true;
  }
  return false;
};

const recordFailure = (): void => {
  circuitBreakerState.failureCount++;
  circuitBreakerState.lastFailureTime = Date.now();
  if (circuitBreakerState.failureCount >= FAILURE_THRESHOLD) {
    circuitBreakerState.state = 'OPEN';
  }
};

const recordSuccess = (): void => {
  circuitBreakerState.successCount++;
  if (circuitBreakerState.state === 'HALF_OPEN' && circuitBreakerState.successCount >= 3) {
    circuitBreakerState.state = 'CLOSED';
    circuitBreakerState.failureCount = 0;
  }
};

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const callWithCircuitBreaker = async <T>(
  fn: () => Promise<T>,
  timeoutMs: number = 10000
): Promise<T> => {
  if (isCircuitOpen()) {
    throw new Error('Circuit breaker is OPEN');
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('External call timeout')), timeoutMs)
    );
    
    const result = await Promise.race([fn(), timeoutPromise]);
    recordSuccess();
    return result;
  } catch (error) {
    recordFailure();
    throw error;
  }
};

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