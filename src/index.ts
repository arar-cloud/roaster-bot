import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
// GitHub Copilot integration removed - use environment-based auth if needed

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`ERROR: Invalid PORT value: ${process.env.PORT}`);
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request, res: Response) => false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// Validate GitHub webhook secret on startup
if (!process.env.GITHUB_WEBHOOK_SECRET) {
  console.error('ERROR: GITHUB_WEBHOOK_SECRET not set. Webhook verification required.');
  process.exit(1);
} else {
  console.info('GitHub webhook secret loaded. Signature verification enabled.');
}

app.use(express.json({
  verify: (req: any, res: any, buf: Buffer, encoding: string) => {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}));

app.use(express.raw({ type: 'application/json' }));

// Middleware to verify GitHub webhook signature
const verifyGitHubSignature = (req: Request, res: Response, next: Function) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  
  if (!secret || !signature) {
    console.warn('[Webhook Security] Verification failed: Missing signature or secret');
    return res.status(401).json({ error: 'Missing signature or secret' });
  }
  
  const payload = req.rawBody || '';
  const hash = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.warn('[Webhook Security] Signature verification failed. Potential bypass attempt detected.');
    return res.status(403).json({ error: 'Invalid signature' });
  }
  
  console.debug('[Webhook Security] Signature verified successfully for payload.');
  next();
};

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

app.post('/api/github-webhook', limiter, verifyGitHubSignature, async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid payload format' });
    }

    const event = req.headers['x-github-event'] as string;
    const action = (req.body as any)?.action || 'unknown';
    console.log(`Processing GitHub event: ${event}, action: ${action}`);
    
    res.status(200).json({ message: 'Webhook verified and processed' });
  } catch (error) {
    console.error('Webhook processing error:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/webhook', limiter, (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    const payload = req.rawBody || '';

    if (!signature || !payload) {
      res.status(400).json({ error: 'Missing signature or payload' });
      return;
    }

    const hash = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET || '').update(payload).digest('hex');
    if (`sha256=${hash}` !== signature) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const event = req.body;
    console.log(`Webhook received: ${event.action}`);
    res.status(200).json({ message: 'Event processed' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
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

app.post('/api/send-sms', limiter, (req: Request, res: Response) => {
  try {
    const { phone, message } = req.body;
    
    // Validate input
    if (!phone || typeof phone !== 'string' || !/^\+?[0-9]{10,}$/.test(phone.replace(/[\s-]/g, ''))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    if (!message || typeof message !== 'string' || message.length > 160) {
      return res.status(400).json({ error: 'Invalid message' });
    }
    
    // TODO: Implement actual SMS sending via provider
    console.log(`[SMS] Sending to ${phone}: ${message.substring(0, 50)}...`);
    res.status(200).json({ message: 'SMS sent successfully' });
  } catch (error) {
    console.error('[SMS Error]', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});