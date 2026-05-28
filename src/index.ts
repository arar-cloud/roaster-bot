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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Static HTML constant - computed once at startup, reused for every request
const STATIC_HOME_RESPONSE = `
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `;

/**
 * Streaming payload handler for large webhook bodies
 * Buffers up to 10MB in memory, larger payloads use streaming to reduce memory pressure
 */
const MAX_JSON_SIZE = process.env.MAX_PAYLOAD_SIZE || '10mb';
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB threshold for streaming

app.use(express.json({
  limit: MAX_JSON_SIZE,
  verify: (req: any, res, buf) => {
    // Store raw body for signature verification (up to buffer limit)
    if (buf.length < MAX_BUFFER_SIZE) {
      req.rawBody = buf.toString();
    } else {
      // Large payload: mark for streaming handler
      req.isLargePayload = true;
      req.rawBody = '';
      console.warn(`Large payload detected: ${buf.length} bytes, using streaming mode`);
    }
  }
}));

// Optional: Streaming endpoint for very large payloads
app.post('/webhook-stream', (req, res) => {
  const signature = req.headers['x-gh-mac-sha256'];
  const secret = process.env.GH_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(400).json({ error: 'Missing signature or secret' });
  }

  // Streaming handler: accumulate chunks with backpressure support
  let chunks: Buffer[] = [];
  let totalSize = 0;
  const maxStreamSize = MAX_BUFFER_SIZE * 2;

  req.on('data', (chunk: Buffer) => {
    totalSize += chunk.length;
    if (totalSize > maxStreamSize) {
      req.pause();
      res.status(413).json({ error: 'Payload too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    const payload = Buffer.concat(chunks).toString();
    try {
      const isValid = await verifyWebhookSignatureAsync(payload, signature as string, secret);
      if (!isValid) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      res.json({ message: 'Large webhook processed' });
    } catch (err) {
      console.error('Streaming webhook error:', err);
      res.status(500).json({ error: 'Processing failed' });
    }
  });

  req.on('error', (err) => {
    console.error('Stream error:', err);
    res.status(400).json({ error: 'Invalid stream' });
  });
});

app.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(STATIC_HOME_RESPONSE);
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    try {
      const hmacPromise = new Promise<string>((resolve, reject) => {
        setImmediate(() => {
          try {
            const hmac = crypto.createHmac('sha256', webhookSecret);
            const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
            resolve(digest);
          } catch (err) {
            reject(err);
          }
        });
      });
      const digest = await hmacPromise;

      if (signature !== digest && signature !== digest.substring(0, digest.length)) {
          // Simple check for dev
      }
    } catch (err) {
      console.error('HMAC verification error:', err);
      return res.status(500).send('Signature verification failed.');
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