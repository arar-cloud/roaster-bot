import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      validatedToken?: string;
    }
  }
}

// Input validation helpers
const validateGitHubToken = (token: string): boolean => {
  // GitHub tokens start with 'ghp_', 'ghu_', 'ghs_', or 'gho_'
  return /^(ghp_|ghu_|ghs_|gho_)[a-zA-Z0-9_]{36,255}$/.test(token);
};

const sanitizePrompt = (input: string): string => {
  // Remove excessive whitespace and limit length
  const sanitized = input.trim().slice(0, 2000);
  return sanitized;
};

const validatePromptContent = (input: string): boolean => {
  // Reject messages with control characters or null bytes
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(input)) {
    return false;
  }
  
  // Detect prompt injection patterns: role-switching or instruction overrides
  const injectionPatterns = [
    /forget[\s\w]*instruction/i,
    /ignore[\s\w]*prompt/i,
    /system[\s\w]*override/i,
    /you[\s\w]*are[\s\w]*now/i,
    /pretend[\s\w]*you/i,
    /act[\s\w]*as[\s\w]*(admin|user|system)/i,
    /"system"\s*:/i,
    /\[SYSTEM\]/i,
  ];
  
  for (const pattern of injectionPatterns) {
    if (pattern.test(input)) {
      return false;
    }
  }
  
  // Reject if input contains excess non-ASCII that might evade filters
  const nonAsciiRatio = (input.match(/[^\x20-\x7E\n\r\t]/g) || []).length / input.length;
  if (nonAsciiRatio > 0.3) {
    return false;
  }
  
  return true;
};

const validateUserMessages = (messages: unknown): string[] => {
  if (!Array.isArray(messages)) {
    throw new Error('userMessages must be an array');
  }
  return messages.map(msg => {
    if (typeof msg !== 'string') {
      throw new Error('Each message must be a string');
    }
    return sanitizePrompt(msg);
  }).slice(0, 10); // Limit to 10 messages
};

const app = express();
const port = process.env.PORT || 3000;

// Validate webhook secret is configured
const webhookSecret = process.env.WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error('WEBHOOK_SECRET environment variable is required for security');
  process.exit(1);
}

// Middleware to generate and set CSP nonce
const nonceMiddleware = (req: Request, res: Response, next: Function) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  (res.locals as any).nonce = nonce;
  next();
};

app.use(nonceMiddleware);

// Apply helmet security headers first
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      // Allow inline styles only with matching nonce (helmet will handle nonce injection)
    },
  },
  xFrameOptions: { action: 'deny' },
  xContentTypeOptions: { nosniff: true },
}));

// Create key generator for per-token rate limiting
const keyGenerator = (req: Request) => {
  // Use GitHub token if provided, otherwise use IP address
  const token = req.headers['x-github-token'] as string;
  return token || req.ip || 'unknown';
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
});

// Stricter rate limiter for AI endpoint to prevent cost abuse
const agentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Much stricter for AI operations
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  skip: (req: Request) => req.method !== 'POST', // Only for POST requests
});

// Token authentication middleware - validates token is present and valid format
const requireTokenAuth = (req: Request, res: Response, next: Function) => {
  const token = req.get('X-GitHub-Token');
  if (!token) {
    return res.status(401).json({ error: 'Missing X-GitHub-Token header' });
  }
  
  if (!validateGitHubToken(token)) {
    return res.status(401).json({ error: 'Invalid GitHub token format' });
  }
  
  (req as any).validatedToken = token;
  next();
};

// Origin verification middleware for token-bearing requests
const verifyTokenOrigin = (req: Request, res: Response, next: Function) => {
  const token = req.get('X-GitHub-Token');
  if (!token) {
    return next(); // No token provided, skip origin check
  }
  
  // If token is present, verify request origin
  const origin = req.get('Origin') || req.get('Referer');
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://github.com').split(',');
  
  if (!origin || !allowedOrigins.some(allowed => origin.includes(allowed))) {
    return res.status(403).json({ error: 'Request origin not verified' });
  }
  
  next();
};

app.use(express.json({
  limit: '1mb',
  verify: (req: Request, res, buf) => {
    (req as any).rawBody = buf.toString();
  }
}));

// CSRF protection middleware
const csrfProtection = (req: Request, res: Response, next: Function) => {
  // Generate CSRF token for GET requests
  if (req.method === 'GET') {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('_csrf', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000
    });
    return next();
  }
  
  // Validate CSRF token for state-changing requests
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const headerToken = req.get('X-CSRF-Token');
    const cookieToken = req.get('Cookie')?.split('_csrf=')[1]?.split(';')[0];
    
    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
  }
  
  next();
};

app.use(csrfProtection);

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

app.post('/agent', limiter, agentLimiter, requireTokenAuth, verifyTokenOrigin, async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');

  if (!signature || !req.rawBody) {
    return res.status(401).json({ error: 'Missing signature or body' });
  }

  // Validate signature format before processing
  if (!signature.startsWith('sha256=') || signature.length !== 71) {
    return res.status(401).json({ error: 'Invalid signature format' });
  }

  try {
    // Compute expected digest using constant-time comparison
    const digest = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  } catch (err) {
    // Prevent secret exposure in error logs
    console.error('Signature verification failed');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');
  
  // Validate GitHub token format
  if (!validateGitHubToken(token)) {
    return res.status(400).json({ error: 'Invalid GitHub token format' });
  }

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

    // Validate and sanitize user messages
    const userMessages = req.body.messages || [];
    if (!Array.isArray(userMessages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    
    const lastMessage = userMessages.filter((m: any) => {
      if (typeof m !== 'object' || !m.role || !m.content) {
        return false;
      }
      if (m.role !== 'user') {
        return false;
      }
      // Validate message content against injection patterns
      if (!validatePromptContent(m.content)) {
        throw new Error('Message content contains invalid patterns');
      }
      return true;
    }).pop();
    
    const prompt = lastMessage ? sanitizePrompt(lastMessage.content) : "Roast me.";
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return res.status(400).json({ error: 'Invalid prompt content' });
    }
    
    // Validate prompt again after sanitization
    if (!validatePromptContent(prompt)) {
      return res.status(400).json({ error: 'Prompt contains invalid patterns' });
    }

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
      try {
        if (!event || typeof event !== 'object') {
          console.error('Invalid event structure received');
          return;
        }
        
        if (event.type === "assistant.message_delta") {
          // Validate response data structure
          if (!event.data || typeof event.data.deltaContent !== 'string') {
            console.error('Invalid response data structure');
            return;
          }
          
          // Sanitize response content before streaming
          const content = event.data.deltaContent.slice(0, 5000); // Limit response chunk size
          const chunk = {
            choices: [{ delta: { content } }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch (err) {
        console.error('Error processing session event:', err instanceof Error ? err.message : 'Unknown error');
      }
    });

    await session.sendAndWait({ prompt });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    // Log error details without exposing secrets
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    // Ensure we never log the webhook secret
    const safeLog = errorMsg.replace(new RegExp(webhookSecret, 'g'), '***');
    console.error('Roaster error:', safeLog);
    if (!res.headersSent) res.status(500).send("The roaster overheated.");
  } finally {
    try {
      await client.stop();
    } catch (stopErr) {
      console.error('Error stopping client');
    }
  }
});

// Bind to localhost by default for security; allow override via environment variable
const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1';
app.listen(port, bindAddress, () => {
  console.log(`Server running on http://${bindAddress}:${port}`);
});