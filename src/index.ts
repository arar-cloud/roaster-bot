import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Validate required environment variables at startup
const requiredEnvVars = ['GITHUB_TOKEN', 'WEBHOOK_SECRET'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`ERROR: Missing required environment variable: ${envVar}`);
    process.exit(1);
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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  verify: (req: Express.Request, res, buf) => {
    (req as any).rawBody = buf.toString();
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

    if (signature !== digest) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  const { userMessages } = req.body;
  if (!userMessages || !Array.isArray(userMessages)) {
    return res.status(400).json({ error: 'Missing or invalid userMessages in request body' });
  }

  // Initialize client with the user's token
  let client: CopilotClient;
  try {
    client = new CopilotClient({
      env: {
        GITHUB_TOKEN: token,
        ...process.env
      }
    });
    if (!client) {
      return res.status(401).json({ error: 'Failed to initialize Copilot client with provided token' });
    }
  } catch (initError) {
    console.error('Client initialization error:', initError);
    return res.status(401).json({ error: 'Invalid GitHub token or authentication failed' });
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

    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    if (!lastMessage || !lastMessage.content) {
      return res.status(400).json({ error: 'No user message content found in userMessages array' });
    }

    const prompt = lastMessage.content;

    // Create session following SDK docs
    let session;
    try {
      session = await client.createSession({
        model: "gpt-4o",
        streaming: false,
        systemMessage: {
          mode: "replace",
          content: systemPrompt
        }
      });
    } catch (sessionError) {
      console.error('Session creation error:', sessionError);
      return res.status(500).json({ error: 'Failed to create Copilot session. Please try again.' });
    }

    if (!session) {
      return res.status(500).json({ error: 'Session creation returned null' });
    }

    let response;
    try {
      response = await session.sendAndWait({ prompt });
    } catch (apiError) {
      console.error('API call error:', apiError);
      return res.status(500).json({ error: 'Failed to get roast from Copilot. The roaster overheated.' });
    }
    
    return res.status(200).json({
      success: true,
      roast: response?.message?.content || 'No response from Copilot',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Unexpected error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'The roaster overheated. An unexpected error occurred.' });
    }
  } finally {
    try {
      if (client) {
        await client.stop();
      }
    } catch (stopError) {
      console.error('Error stopping client:', stopError);
    }
  }
});

const server = app.listen(port, () => {
  console.log(`✓ Server is running on http://localhost:${port}`);
  console.log(`✓ Environment validation passed`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

export default app;