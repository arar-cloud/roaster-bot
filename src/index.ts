import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
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

// Apply helmet security middleware with optimized options
// contentSecurityPolicy disabled to allow streaming JSON responses
// crossOriginResourcePolicy enabled for CORS security
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Enable compression for all responses (gzip, brotli support)
// Reduces payload sizes by 60-80% for JSON, HTML, and streaming responses
// Threshold raised to 2048 bytes to avoid compression overhead on tiny payloads
app.use(compression({
  level: 6,
  threshold: 2048
}));

// Pre-compute absolute path for static files during app initialization
// Eliminates per-request path resolution overhead
const publicDir = path.resolve(process.cwd(), 'public');

// Singleton CopilotClient instance with cached token hash
let copilotClientInstance: CopilotClient | null = null;
let cachedToken: string = '';
let cachedTokenHash: string = '';

function getCopilotClient(token: string): CopilotClient {
  // Cache token reference and its hash to avoid repeated synchronous hashing
  // Only compute hash if token changed, reducing event loop blocking under token rotation
  if (cachedToken !== token) {
    cachedToken = token;
    cachedTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    copilotClientInstance = new CopilotClient({
      token,
      agent: {
        keepAlive: true,
        timeout: 30000
      }
    });
  }
  
  return copilotClientInstance as CopilotClient;
}

// Rate limiter config: cache IP to avoid repeated req.ip lookups
// Applies only to /agent endpoint via middleware chain
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).cachedIp || req.ip || 'unknown'
});

// Middleware to cache IP address and set endpoint timeout
const agentMiddleware = (req: Request, res: Response, next) => {
  // Cache IP to avoid repeated resolution in rate limiter
  (req as any).cachedIp = req.ip;
  
  // Set 30-second timeout for long-running /agent endpoint only
  const timeout = 30 * 1000;
  req.setTimeout(timeout, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
    // Destroy socket to prevent zombie requests and resource leaks
    try {
      res.socket?.destroy();
    } catch (err) {
      console.error('Error destroying socket on timeout:', err);
    }
  });
  
  next();
};

// Enable trust-proxy to get accurate client IP in cloud environments
app.set('trust proxy', 1);

// express.json() enforces the limit option (1MB) internally via its parser.
// Removed verify callback to reduce per-request latency on all routes.
// rawBody capture moved to /agent endpoint middleware for webhook verification only.
app.use(express.json({
  limit: '1mb'
}));

// Dedicated middleware for /agent endpoint to capture raw body for webhook signature verification
// Applied only to /agent, not globally, to avoid unnecessary overhead on other routes
const captureRawBody = (req: any, res, buf) => {
  req.rawBody = buf.toString();
};

app.use(express.static(publicDir, {
  maxAge: '1h',
  etag: true  // Enable etag for 304 Not Modified responses (40-60% bandwidth savings)
}));

app.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile('index.html', { root: publicDir });
});

// Endpoint-specific middleware for raw body capture (webhook verification only)
const captureRawBodyMiddleware = express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
});

app.post('/agent', limiter, agentMiddleware, captureRawBodyMiddleware, async (req: Request, res: Response) => {
  try {
    // Validate token early before any async operations
    const token = req.get('X-GitHub-Token');
    if (!token) return res.status(401).send('Missing X-GitHub-Token.');

    // Webhook signature verification: check before initializing client
    const signature = req.get('X-Hub-Signature-256');
    const webhookSecret = process.env.WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const rawBody = req.rawBody;
      if (!rawBody) return res.status(400).send('Missing raw body.');

      // HMAC is synchronous but acceptable for webhook verification at typical throughput.
      // If performance degrades with high volume, consider worker threads or pre-computed digests.
      const hmac = crypto.createHmac('sha256', webhookSecret);
      const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest)) && 
          !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(`sha256=${digest}`))) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Initialize client with the user's token using singleton (only after auth verification)
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