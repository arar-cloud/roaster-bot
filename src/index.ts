import 'dotenv/config';
import express, onse } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
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

// Input validation middleware
const validateInput = (req: Request, res: Response, next: Function) => {
  const contentType = req.get('content-type');
  if (contentType && !contentType.includes('application/json')) {
    return res.status(400).json({ error: 'Invalid content-type' });
  }
  next();
};

const sanitizeInput = (data: any): any => {
  if (typeof data === 'string') {
    // Remove potentially dangerous characters and patterns
    return data.replace(/[<>"'`]/g, '').slice(0, 10000);
  }
  if (typeof data === 'object' && data !== null) {
    return Object.keys(data).reduce((acc, key) => {
      acc[key] = sanitizeInput(data[key]);
      return acc;
    }, {} as any);
  }
  return data;
};

// CSRF protection middleware (issue-14b16fa020)
const csrfTokens = new Map<string, { token: string; createdAt: number }>();
const generateCSRFToken = (): string => crypto.randomBytes(32).toString('hex');

app.use((req: Request, res: Response, next) => {
  const token = generateCSRFToken();
  const sessionId = crypto.randomBytes(16).toString('hex');
  csrfTokens.set(sessionId, { token, createdAt: Date.now() });
  res.cookie('sessionId', sessionId, { httpOnly: true, secure: true, sameSite: 'strict' });
  res.setHeader('X-CSRF-Token', token);
  next();
});

// CSRF validation for state-changing methods
const validateCSRF = (req: Request, res: Response, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const sessionId = req.cookies?.sessionId;
    const token = req.headers['x-csrf-token'];
    const stored = sessionId ? csrfTokens.get(sessionId) : null;
    if (!stored || stored.token !== token || Date.now() - stored.createdAt > 3600000) {
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
  }
  next();
};
app.use(validateCSRF);

// Security headers
// Secure session store (in-memory for this example; use Redis in production)
const sessions = new Map<string, { userId: string; expires: number }>();

const generateSessionToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

const validateSession = (req: Request, res: Response, next: Function) => {
  const token = req.get('authorization')?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(token);
  if (session && session.expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  (req as any).userId = session?.userId;
  next();
};

app.use((req: Request, res: Response, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  next();
});

// Token verification middleware
const verifyToken = (req: Request, res: Response, next: Function) => {
  const token = req.headers['x-auth-token'] as string;
  const expectedToken = process.env.ROASTER_AUTH_TOKEN;
  if (!token || !expectedToken || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
  limit: '10kb' // Prevent payload bomb attacks
}));

// Input validation middleware
app.use((req: Request, Response, next) => {
  if (req.method === 'POST' && req.path === '/webhook') {
    // Validate webhook event structure
    const event = req.get('x-github-event');
    if (!event || typeof event !== 'string' || event.length > 50) {
      return res.status(400).send('Invalid webhook event header');
    }
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).send('Invalid JSON payload');
    }
  }
  next();
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

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // Webhook signature verification using HMAC-SHA256
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!signature) {
    return res.status(401).json({ error: 'Unauthorized: Missing signature' });
  }

  if (!webhookSecret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'Missing raw body' });
  }

  const hash = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expected = `sha256=${hash}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
  }

  const token = req.get('X-GitHub-Token');
  if (!token) return res.status(401).send('Missing X-GitHub-Token.');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return res.status(401).send('Invalid X-GitHub-Token format or length.');
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return res.status(401).send('Invalid X-GitHub-Token: contains forbidden characters.');

  // Validate token format (prevent injection)
  const tokenPattern = /^[a-zA-Z0-9_.-]+$/;
  if (!tokenPattern.test(token)) {
    return res.status(400).send('Invalid token format.');
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

    const userMessages = req.body.messages || [];
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    let prompt = lastMessage ? lastMessage.content : "Roast me.";

    // Validate and sanitize prompt parameter
    if (typeof prompt !== 'string') return res.status(400).send('Prompt must be a string.');
    if (prompt.length > 10000) return res.status(400).send('Prompt exceeds maximum length of 10000 characters.');
    if (prompt.trim().length === 0) return res.status(400).send('Prompt cannot be empty or whitespace only.');

    // Create session following SDK docs with validation
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
      if (!session || typeof session !== 'object') throw new Error('Invalid session object returned from createSession');
    } catch (err) {
      console.error('Session creation failed:', err instanceof Error ? err.message : String(err));
      return res.status(500).send('Failed to initialize session.');
    }

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
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  } finally {
    await client.stop();
  }
});

const roastLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
});

app.post('/roast', roastLimiter, verifyToken, async (req: Request, res: Response) => {
  // Validate authentication token
  const authHeader = req.headers.authorization as string;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    return;
  }
  const expectedToken = process.env.API_TOKEN || '';
  const token = authHeader.slice(7);
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
    return;
  }
  // Security: strict input validation (issue-7166c46bfe)
  let { code } = req.body;
  
  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid code input' });
  }
  if (code.length > 50000) {
    return res.status(413).json({ error: 'Code exceeds maximum length' });
  }
  
  code = code.trim();
  
  // Sanitize: prevent XSS by escaping HTML
  const sanitized = code.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char));
  
  // Security: safe code parsing without eval (issue-7c08b303ad)
  // Replace with AST parsing instead of pattern matching
  let isValidCode = true;
  try {
    // Use simple validation: check for eval/Function constructor patterns
    const forbiddenPatterns = /(\beval\s*\(|new\s+Function\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\()/gi;
    if (forbiddenPatterns.test(sanitized)) {
      isValidCode = false;
    }
  } catch (e) {
    isValidCode = false;
  }
  
  if (!isValidCode) {
    res.status(400).json({ error: 'Bad request: Code contains unsafe patterns (eval, Function constructor, or dynamic execution)' });
    return;
  }

  try {
    const client = new CopilotClient();
    const sanitizedPrompt = `Roast this code snippet: ${sanitized.slice(0, 1000)}`;
    const roastResult = await client.generateCompletion({
      prompt: sanitizedPrompt,
    });
    if (!roastResult || typeof roastResult !== 'object') {
      throw new Error('Invalid response from AI client');
    }
    res.json(roastResult);
  } catch (error) {
    res.status(500).json({ error: 'Failed to roast code' });
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});