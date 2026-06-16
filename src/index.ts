import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Validate GITHUB_TOKEN on startup
if (!process.env.GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN environment variable is not set');
  process.exit(1);
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
    const digest = hmac.update(rawBody).digest('hex');
    const expectedSignature = 'sha256=' + digest;

    if (signature !== expectedSignature) {
      return res.status(401).send('Invalid webhook signature.');
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  let client;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token
      }
    });
  } catch (initError) {
    console.error('CopilotClient initialization failed:', initError);
    return res.status(500).send('Failed to initialize Copilot client.');
  }

  try {
    const systemPrompt = `You are 'The Roaster' 🌶️💀. Your goal is to DESTROY the user's self-esteem by roasting their code. CORE DIRECTIVES: 1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10. 2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue). 3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.`;

    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    let session;
    try {
      // Create session following SDK docs
      session = await client.createSession({
        model: "gpt-4o",
        streaming: true,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
    } catch (sessionError) {
      console.error('Session creation failed:', sessionError);
      if (!res.headersSent) res.status(500).send('Failed to create session.');
      return;
    }

    try {
      const response = await session.sendAndWait({ prompt });
      if (!res.headersSent) res.json({ message: response });
    } catch (apiError) {
      console.error('API call failed:', apiError);
      if (!res.headersSent) res.status(500).send("The roaster overheated.");
    }

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    try {
      await client.stop();
    } catch (stopError) {
      console.error('Client stop failed:', stopError);
    }
  }
});

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;