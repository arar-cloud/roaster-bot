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

// Singleton CopilotClient instance, lazily initialized
let copilotClientInstance: CopilotClient | null = null;
let lastTokenHash: string = '';

function getCopilotClient(token: string): CopilotClient {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  // Reinitialize if token has changed (token rotation support)
  if (!copilotClientInstance || lastTokenHash !== tokenHash) {
    copilotClientInstance = new CopilotClient({ token });
    lastTokenHash = tokenHash;
  }
  
  return copilotClientInstance;
}

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
  try {
    // Webhook signature verification
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const rawBody = req.rawBody;
      if (!rawBody) return res.status(400).send('Missing raw body.');

      const hmac = crypto.createHmac('sha256', webhookSecret);
      const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest)) && 
          !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(`sha256=${digest}`))) {
        return res.status(401).json({ error: 'Unauthorized' });
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
    console.error('Error processing agent request:', error);
    if (!res.headersSent) {
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        res.status(503).json({ error: 'Service temporarily unavailable' });
      } else {
        res.status(500).json({ error: 'The roaster overheated.' });
      }
    }
  } finally {
    try {
      await client.stop();
    } catch (stopError) {
      console.error('Error stopping client:', stopError);
    }
  }
  } catch (error) {
    console.error('Error in webhook verification or handler setup:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});