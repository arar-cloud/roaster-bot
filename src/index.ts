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

// Validate critical environment variables at startup
function validateEnvironment(): void {
  const requiredVars = ['WEBHOOK_SECRET', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];
  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Fatal: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

validateEnvironment();

const app = express();
const port = process.env.PORT || 3000;

// Configure timeouts
const REQUEST_TIMEOUT = 60000; // 60 seconds
const RESPONSE_TIMEOUT = 120000; // 120 seconds

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT);
  res.setTimeout(RESPONSE_TIMEOUT);
  next();
});

app.use(helmet());

// Structured logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = crypto.randomBytes(8).toString('hex');
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('user-agent'),
    }));
  });
  
  next();
});

app.use(express.json({
  verify: (req: any, res, buf) => {
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
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (!signature || (signature !== digest && signature !== `sha256=${digest}`)) {
        console.warn('Webhook: Invalid signature received');
        return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  let client: CopilotClient | null = null;
  
  try {
    try {
      client = new CopilotClient({
        env: {
          GITHUB_TOKEN: token,
          ...process.env
        }
      });
    } catch (initErr) {
      console.error('Copilot client initialization failed:', initErr);
      return res.status(503).json({ error: 'Service temporarily unavailable', retry: true });
    }
    
    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.
      
      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    const userMessages = req.body.messages || [];
    
    if (!Array.isArray(userMessages)) {
      return res.status(400).json({ error: 'Invalid request: messages must be an array' });
    }
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Create session following SDK docs
    let session;
    try {
      session = await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
    } catch (sessionErr) {
      console.error('Failed to create Copilot session:', sessionErr);
      return res.status(503).json({ error: 'Service temporarily unavailable', retry: true });
    }

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

// Graceful shutdown handlers
function gracefulShutdown(signal: string): void {
  console.log(`${signal} received: starting graceful shutdown`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown: in-flight requests did not complete in time');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));