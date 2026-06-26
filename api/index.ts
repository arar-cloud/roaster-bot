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

// Validate critical environment variables at startup
if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is required');
}
if (!process.env.WEBHOOK_SECRET) {
  throw new Error('WEBHOOK_SECRET environment variable is required');
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    if (!buf) {
      throw new Error('Request body is missing');
    }
    req.rawBody = buf.toString();
  }
}));

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `);
});

app.post('/webhook', limiter, (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string;
  const payload = req.rawBody;

  if (!signature || !payload) {
    res.status(401).json({ error: 'Unauthorized: missing signature or payload' });
    return;
  }

  const secret = process.env.WEBHOOK_SECRET!;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (signature !== digest) {
    res.status(401).json({ error: 'Unauthorized: invalid signature' });
    return;
  }

  res.status(200).json({ message: 'Webhook verified' });
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  try {
    const { userMessages } = req.body;

    if (!userMessages || !Array.isArray(userMessages)) {
      res.status(400).json({ error: 'userMessages array is required' });
      return;
    }

    const copilotClient = new CopilotClient({
      token: process.env.GITHUB_TOKEN!,
    });

    const response = await copilotClient.chat.completions.create({
      model: 'gpt-4',
      messages: userMessages,
    });

    res.status(200).json(response);
  } catch (error) {
    console.error('Error in /agent endpoint:', error);
    res.status(500).json({ error: 'Internal server error', details: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;