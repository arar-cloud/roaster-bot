import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      }
    } catch (error) {
      const sanitizedError = error instanceof Error
        ? error.message.replace(token, '[REDACTED]')
        : 'Failed to initialize CopilotClient';
      throw new Error(sanitizedError);
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

app.use(express.json({
  limit: '10kb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use(express.static('public'));

// Middleware: Verify webhook signature before rate limiting
function verifyWebhookSignature(req: any, res: Response, next: Function) {
  if (req.path === '/agent' && req.method === 'POST') {
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(500).send('Webhook secret not configured');
    }

    if (!signature) {
      return res.status(401).send('Missing signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const isValid = crypto.timingCompare(signature, expectedSignature);
    
    if (!isValid) {
      return res.status(401).send('Invalid signature');
    }
  }
  next();
}

app.use(verifyWebhookSignature);

function getCopilotClient(token: string): CopilotClient {
  // Create per-request client instance to prevent token cross-contamination
  // Each request gets its own isolated CopilotClient with dedicated token context
  return new CopilotClient({
    env: {
      GITHUB_TOKEN: token,
      ...process.env
    }
  });
}

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Signature already verified by middleware
  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');

  // Retrieve singleton client (connection pool reused)
  const client = getCopilotClient(token);

  try {
    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.

      CORE DIRECTIVES:
      1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10.
      2. TONE: Ruthless, savage, Gen Z, toxic (L, ratio, no cap, skill issue).
      3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.
    `;

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).send('Invalid request: messages must be an array');
    }

    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    if (!lastMessage || !lastMessage.content) {
      return res.status(400).send('Invalid request: no user message found');
    }
    const prompt = lastMessage.content;

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
    const errorMessage = error instanceof Error ? error.message.replace(token, '[REDACTED]') : 'Unknown error';
    console.error('CopilotClient error:', errorMessage);

    if (!res.headersSent) {
      if (error instanceof Error && error.message.includes('401')) {
        res.status(401).send('Authentication failed with GitHub API');
      } else if (error instanceof Error && error.message.includes('429')) {
        res.status(429).send('Rate limited by GitHub API');
      } else {
        res.status(500).send("The roaster overheated.");
      }
    }
  } finally {
    await client.stop();
  }
});

const server = app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});