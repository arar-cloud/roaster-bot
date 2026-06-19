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

// Validate and parse PORT environment variable
const parsePort = (portEnv: string | undefined): number => {
  const defaultPort = 3000;
  if (!portEnv) return defaultPort;
  
  const parsed = parseInt(portEnv, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`Invalid PORT value '${portEnv}', using default ${defaultPort}`);
    return defaultPort;
  }
  return parsed;
};

const port = parsePort(process.env.PORT);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  limit: '1mb',
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
  try {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
      res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
      return;
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Initialize client with the user's token
  const sanitizedToken = token.trim();
  let client;
  try {
    const clientConfig: any = {
      env: {
        GITHUB_TOKEN: sanitizedToken,
        ...process.env
      }
    };
    
    // Allow configurable endpoint via environment variable
    if (process.env.COPILOT_ENDPOINT) {
      clientConfig.endpoint = process.env.COPILOT_ENDPOINT;
    }
    
    client = new CopilotClient(clientConfig);
  } catch (initError) {
    console.error('Failed to initialize CopilotClient:', initError);
    res.status(500).json({ error: 'Failed to initialize Copilot client' });
    return;
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

    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Create session following SDK docs
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    let session;
    try {
      session = await Promise.race([
        client.createSession({
          model: "gpt-4o",
          streaming: true,
          systemMessage: {
            mode: "replace",
            content: systemPrompt
          }
        }),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('CopilotClient API timeout')));
        })
      ]);
    } catch (timeoutError) {
      console.error('CopilotClient API timeout:', timeoutError);
      res.status(504).json({ error: 'API request timeout' });
      clearTimeout(timeoutId);
      return;
    } finally {
      clearTimeout(timeoutId);
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
  } catch (handlerError) {
    console.error('Unhandled error in POST /agent handler:', handlerError);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});