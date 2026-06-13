import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Sanitize sensitive environment variable keys
const sensitiveKeys = ['token', 'secret', 'password', 'api_key', 'key', 'authorization'];
const sanitizeEnv = (key: string): boolean => sensitiveKeys.some(k => key.toLowerCase().includes(k));

// Audit logging middleware
const auditLog = (event: string, details: any) => {
  const sanitizeDetails = (obj: any): any => {
    const sanitized = { ...obj };
    Object.keys(sanitized).forEach(key => {
      if (sanitizeEnv(key)) {
        sanitized[key] = '[REDACTED]';
      }
    });
    return sanitized;
  };
  console.info(`[AUDIT] event=${event}, details=${JSON.stringify(sanitizeDetails(details))}, timestamp=${new Date().toISOString()}`);
};

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

// Mark sensitive environment variables
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('FATAL: WEBHOOK_SECRET environment variable must be set');
  process.exit(1);
}

// Ensure sensitive env vars are never logged
const sanitizeEnv = (key: string): boolean => {
  const sensitiveKeys = ['WEBHOOK_SECRET', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'TOKEN'];
  return sensitiveKeys.some(k => key.toUpperCase().includes(k));
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  keyGenerator: (req) => req.header('X-GitHub-Token') || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://github.com', 'https://api.github.com'],
      frameAncestors: ["'none'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Request logging middleware
app.use((req: Request, res: Response, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    auditLog('REQUEST_COMPLETE', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      ip: req.ip,
      duration
    });
  });
  next();
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// HTML escaping utility
const escapeHtml = (text: string): string => {
  const escapeMap: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;'
  };
  return text.replace(/[&<>"'\/]/g, (char) => escapeMap[char]);
};

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `);
});

app.post('/agent', limiter, tokenLimiter, async (req: Request, res: Response) => {
  // CORS origin validation with strict hostname matching
  const origin = req.header('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const allowedHosts = ['github.com', 'www.github.com'];
      if (!allowedHosts.includes(originUrl.hostname)) {
        console.warn(`[CORS_FAIL] Invalid origin hostname: ${originUrl.hostname} from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    } catch (e) {
      console.warn(`[CORS_FAIL] Malformed origin URL from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');

  if (WEBHOOK_SECRET && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      console.warn(`[WEBHOOK_VALIDATION_FAIL] Missing request body for signature validation from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    const signatureBuffer = Buffer.from(signature || '', 'utf8');
    const digestBuffer = Buffer.from(digest, 'utf8');
    
    let isValid = false;
    try {
      isValid = signatureBuffer.length === digestBuffer.length && crypto.timingSafeEqual(signatureBuffer, digestBuffer);
    } catch (e) {
      isValid = false;
    }

    if (!isValid) {
      console.warn(`[AUTH_FAIL] Webhook signature verification failed from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    console.info(`[AUTH_SUCCESS] Webhook validated from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
  }

  const token = req.get('X-GitHub-Token');
  if (!token) {
    console.warn(`[TOKEN_AUTH_FAIL] Missing authentication token from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
    return res.status(401).send('Unauthorized');
  }
  console.info(`[TOKEN_AUTH_SUCCESS] Token provided from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
  if (typeof token !== 'string' || token.length < 36 || token.length > 255 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    console.warn(`[TOKEN_INVALID] Invalid token format from IP: ${req.ip}, token_length: ${token?.length}, timestamp: ${new Date().toISOString()}`);
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  console.info(`[TOKEN_ACCEPTED] Valid token from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);

  // Validate request body structure and constraints
  if (!req.body || typeof req.body !== 'object') {
    console.warn(`[REQUEST_INVALID] Request body is not an object from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const messages = req.body.messages;
  if (messages && (!Array.isArray(messages) || messages.length > 100)) {
    console.warn(`[REQUEST_INVALID] Messages validation failed (not array or exceeds limit) from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  // Validate each message object depth and field types
  if (messages) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (typeof msg !== 'object' || msg === null) continue;
      
      const msgStr = JSON.stringify(msg);
      if (msgStr.length > 10000) {
        console.warn(`[REQUEST_INVALID] Message exceeds size limit at index ${i} from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
    }
  }

  // Initialize client with the user's token
  const client = new CopilotClient({
    env: {
      GITHUB_TOKEN: token
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

    const sanitizeContent = (content: any): string => {
      if (typeof content !== 'string') return '';
      return content
        .substring(0, 5000)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .trim();
    };

    const userMessages = (req.body.messages || [])
      .filter((msg: any) => typeof msg === 'object' && msg !== null)
      .map((msg: any) => {
        const sanitized: any = { ...msg };
        if (msg.content) {
          sanitized.content = sanitizeContent(msg.content);
        }
        if (msg.role && typeof msg.role === 'string') {
          sanitized.role = msg.role.substring(0, 50).replace(/[^a-z]/gi, '');
        }
        return sanitized;
      });
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
        // Validate and sanitize response content
        let content = event.data.deltaContent;
        if (typeof content !== 'string') {
          console.warn(`[RESPONSE_INVALID] Non-string content from Copilot API, type: ${typeof content}`);
          content = '';
        }
        // Remove control characters and limit length per chunk
        content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').substring(0, 10000);
        
        const chunk = {
          choices: [{ delta: { content: content } }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    });

    await session.sendAndWait({ prompt });
    console.info(`[AGENT_SUCCESS] Request completed for token from IP: ${req.ip}, timestamp: ${new Date().toISOString()}`);

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[AGENT_ERROR] Request failed from IP: ${req.ip}, error: ${errorMessage}, timestamp: ${new Date().toISOString()}`);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});