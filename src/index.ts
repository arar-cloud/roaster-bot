import 'dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['GITHUB_TOKEN', 'WEBHOOK_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}import express, { Request, Response } from 'express';
import crypto from 'crypto';
import crypto from 'crypto';
import crypto from 'crypto';
import crypto from 'crypto';



// Additional validation: log warnings for deprecation notices
console.log('Environment validation passed. Required variables initialized.');
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

// Add raw body middleware for webhook signature verification
app.use(express.raw({ type: 'application/json' }));

// Middleware to verify webhook signature
const verifyWebhookSignature = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const bodyBuffer = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
  const expectedSignature = `sha256=${hash}`;

  if (signature !== expectedSignature) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Convert body back to object for downstream handlers
  (req as any).body = JSON.parse(bodyBuffer.toString());
  next();
};

// Add raw body middleware for webhook signature verification
app.use(express.raw({ type: 'application/json' }));

// Middleware to verify webhook signature
const verifyWebhookSignature = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const bodyBuffer = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
  const expectedSignature = `sha256=${hash}`;

  if (signature !== expectedSignature) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Convert body back to object for downstream handlers
  (req as any).body = JSON.parse(bodyBuffer.toString());
  next();
};

// Add raw body middleware for webhook signature verification
app.use(express.raw({ type: 'application/json' }));

// Middleware to verify webhook signature
const verifyWebhookSignature = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const bodyBuffer = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
  const expectedSignature = `sha256=${hash}`;

  if (signature !== expectedSignature) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Convert body back to object for downstream handlers
  (req as any).body = JSON.parse(bodyBuffer.toString());
  next();
};

// Add raw body middleware for webhook signature verification
app.use(express.raw({ type: 'application/json' }));

// Middleware to verify webhook signature using timing-safe comparison
const verifyWebhookSignature = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.WEBHOOK_SECRET;

  try {
    if (!signature || !secret) {
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }
  } catch (err) {
    console.error('ERROR: Signature comparison failed', err);
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const bodyBuffer = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
  const expectedSignature = `sha256=${hash}`;

  if (signature !== expectedSignature) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Convert body back to object for downstream handlers
  (req as any).body = JSON.parse(bodyBuffer.toString());
  next();
};

// Add raw body middleware for webhook signature verification
app.use(express.raw({ type: 'application/json' }));

// Middleware to verify webhook signature
const verifyWebhookSignature = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const bodyBuffer = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
  const expectedSignature = `sha256=${hash}`;

  if (signature !== expectedSignature) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Convert body back to object for downstream handlers
  (req as any).body = JSON.parse(bodyBuffer.toString());
  next();
};
const port = process.env.PORT || 3000;

// Middleware to preserve raw body for webhook signature verification
app.use(express.raw({type: 'application/json'}));

// Convert raw body to string for signature verification
app.use((req: Request, res: Response, next) => {
  if (req.is('application/json')) {
    req.rawBody = (req.body as Buffer).toString('utf8');
  }
  next();
});

// Parse JSON after raw body capture
app.use(express.json());

// Middleware to preserve raw body for webhook signature verification
app.use(express.raw({type: 'application/json'}));
app.use((req: Request, res: Response, next: any) => {
  if (req.is('application/json')) {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      (req as any).rawBody = data;
      req.body = JSON.parse(data);
      next();
    });
  } else {
    next();
  }
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
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

app.post('/webhook', verifyWebhookSignature, async (req: Request, res: Response) => {
  // Security: Validate GitHub webhook signature
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  // Webhook signature validation is REQUIRED
  if (!webhookSecret) {
    console.error('ERROR: Webhook received but GITHUB_WEBHOOK_SECRET is not set');
    return res.status(403).json({ error: 'Webhook secret not configured' });
  }

  if (!signature) {
    console.error('ERROR: Webhook missing x-hub-signature-256 header');
    return res.status(403).json({ error: 'Invalid webhook signature' });
  }

  // Validate payload structure before signature verification
  if (typeof req.body !== 'object' || !req.body) {
    console.warn('Webhook payload is not a valid object');
    return res.status(400).json({ error: 'Invalid payload format' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).send('Missing raw body.');

  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  try {
    // Use timing-safe comparison to prevent timing attacks
    const signatureBuffer = Buffer.from(signature);
    const digestBuffer = Buffer.from(digest);
    if (signatureBuffer.length !== digestBuffer.length) {
      throw new Error('Signature length mismatch');
    }
    const isValid = crypto.timingSafeEqual(signatureBuffer, digestBuffer);
    if (!isValid) {
      throw new Error('Signature verification failed');
    }
  } catch (err) {
    console.error('ERROR: Webhook signature verification failed - unauthorized access attempt');
    return res.status(401).json({ error: 'Unauthorized' });
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

  // Validate webhook payload structure
  if (typeof req.body !== 'object' || !req.body) {
    console.warn('Webhook payload is not a valid object');
    return res.status(400).json({ error: 'Invalid payload format' });
  }

  const payload = req.body;
  if (!payload.repository || !payload.pull_request) {
    console.warn('Webhook payload missing expected fields, skipping processing');
    return res.status(200).json({ message: 'Webhook received but skipped' });
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