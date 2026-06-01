// Direct import and export of Express app to eliminate module boundary overhead
// This avoids extra module resolution steps in serverless environments
import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

const copilotClient = new CopilotClient({
  token: process.env.COPILOT_API_TOKEN || '',
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
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
  res.setHeader('Cache-Control', 'public, immutable, max-age=31536000');
  res.sendFile('public/index.html', { root: '.' });
});

app.use(express.static('public', {
  maxAge: '1y',
  etag: false,
  lastModified: false,
}));

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-github-hook-secret'] as string;
  const payload = req.rawBody || '';
  const secret = process.env.WEBHOOK_SECRET || '';

  if (!signature || !secret) {
    res.status(401).json({ error: 'Unauthorized: missing signature or secret' });
    return;
  }

  const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedSignature = `sha256=${hash}`;
  
  try {
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    res.json({ message: 'Webhook received' });
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized: invalid signature' });
  }
});

app.post('/agent', limiter, async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Copilot API timeout')), 30000)
    );

    const response = await Promise.race([
      copilotClient.getCompletions({ prompt: message }),
      timeoutPromise
    ]);

    res.json({ response });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: errorMessage });
  }
});

export default app;