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

// Singleton CopilotClient instance (created once, reused across requests)
let copilotClient: CopilotClient | null = null;

function getCopilotClient(): CopilotClient {
  if (!copilotClient) {
    copilotClient = new CopilotClient({
      token: process.env.GITHUB_TOKEN || '',
    });
  }
  return copilotClient;
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to capture raw body BEFORE JSON parsing (preserves original Buffer)
app.use((req: any, res, next) => {
  let rawData = '';
  req.on('data', (chunk: Buffer) => {
    rawData += chunk.toString('utf8');
  });
  req.on('end', () => {
    req.rawBody = rawData;
    next();
  });
});

app.use(express.json());

// Serve static files from public directory
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/public/index.html');
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification with constant-time comparison
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    // Compute HMAC digest once and use constant-time comparison
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const computedDigest = hmac.update(rawBody).digest('hex');
    const expectedSignature = `sha256=${computedDigest}`;
    
    try {
      const signatureBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);
      if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return res.status(401).send('Invalid signature.');
      }
    } catch (err) {
      return res.status(401).send('Invalid signature.');
    }
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Track request timing for performance metrics
  const requestStartTime = Date.now();
  const client = getCopilotClient();
  
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

    // Create session following SDK docs with nested error handling
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
    } catch (sessionError) {
      console.error('Session creation failed:', sessionError);
      return res.status(500).send('Failed to create session.');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      session.on((event: any) => {
        if (event.type === "assistant.message_delta") {
          const chunk = {
            choices: [{ delta: { content: event.data.deltaContent } }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      });

      await session.sendAndWait({ prompt });
    } catch (streamError) {
      console.error('Stream processing failed:', streamError);
      res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    // Don't stop singleton client; keep it alive for request reuse
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});