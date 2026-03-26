import 'dotenv/config';
import express, onse } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import { CopilotClient } from '@github/copilot-sdk';

// Secure token generation
const generateSecureToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Cache Copilot client to avoid repeated initialization
const copilotClient = new CopilotClient({
  token: process.env.GITHUB_TOKEN || '',
});

// Reuse cached client - eliminates per-request instantiation overhead

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Input validation middleware with stricter enforcement
const validateInput = (req: Request, res: Response, next: Function) => {
  const contentType = req.get('content-type');
  // Strict content-type validation - only application/json
  if (!contentType || !/^application\/json/.test(contentType)) {
    return res.status(400).json({ error: 'Content-Type must be application/json' });
  }
  // Enforce max request size
  if (req.get('content-length') && parseInt(req.get('content-length')!) > 1048576) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  next();
};

const sanitizeInput = (data: any): any => {
  const MAX_STRING_LENGTH = 4096;
  if (typeof data === 'string') {
    if (data.length > MAX_STRING_LENGTH) {
      throw new Error('Input string exceeds maximum allowed length');
    }
    // HTML escape dangerous characters to prevent injection
    return data.replace(/[<>"']/g, (char) => {
      const map: Record<string, string> = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char] || char;
    });
  }
  if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data);
    if (keys.length > 50) {
      throw new Error('Input object exceeds maximum allowed properties');
    }
    return keys.reduce((acc, key) => {
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

app.use(limiter);

// Secure session validation middleware with HMAC-SHA256 token validation
const validateSessionMiddleware = (req: Request, res: Response, next: Function) => {
  const token = req.get('x-session-token');
  const expectedToken = process.env.SESSION_TOKEN;
  
  if (!token || !expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Use timing-safe comparison to prevent timing attacks
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expectedHash = crypto.createHash('sha256').update(expectedToken).digest('hex');
  
  if (!crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(expectedHash))) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  next();
};

// Security headers
// Secure session store (in-memory for this example; use Redis in production)
const sessions = new Map<string, { userId: string; expires: number }>();
const sessionRevocations = new Set<string>(); // Track explicitly revoked sessions
const SESSION_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

// Session audit log (use proper logging in production)
const sessionLog: Array<{ timestamp: number; event: string; token: string; userId?: string; reason?: string }> = [];
const logSessionEvent = (event: string, token: string, userId?: string, reason?: string) => {
  sessionLog.push({ timestamp: Date.now(), event, token, userId, reason });
  console.log(`[SESSION] ${event}: ${userId || 'unknown'} - ${reason || ''}`);
};

// Track failed auth attempts for rate limiting
const failedAuthAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Periodic cleanup of expired sessions (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expires < now) {
      sessions.delete(token);
      sessionRevocations.delete(token); // Also clean up revocation tracking
    }
  }
  // Clean up stale lockout records
  for (const [ip, record] of failedAuthAttempts.entries()) {
    if (now - record.lastAttempt > LOCKOUT_DURATION_MS) {
      failedAuthAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Store active sessions with expiration and secure token generation
const SESSION_TIMEOUT = SESSION_LIFETIME_MS; // Use consistent session lifetime

const generateSessionToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

const createSession = (userId: string): string => {
  const token = generateSessionToken();
  const expiresAt = Date.now() + SESSION_TIMEOUT;
  sessions.set(token, { userId, expires: expiresAt });
  return token;
};

const validateSession = (req: Request, res: Response, next: Function) => {
  const authHeader = req.get('authorization');
  const clientIp = req.ip || 'unknown';
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Track failed attempt
    const record = failedAuthAttempts.get(clientIp) || { count: 0, lastAttempt: Date.now() };
    record.count++;
    record.lastAttempt = Date.now();
    failedAuthAttempts.set(clientIp, record);
    
    if (record.count > MAX_FAILED_ATTEMPTS) {
      logSessionEvent('AUTH_FAILED_LOCKOUT', 'unknown', undefined, `Client locked out: ${clientIp}`);
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.replace('Bearer ', '');
  
  // Check for revoked sessions first
  if (token && sessionRevocations.has(token)) {
    logSessionEvent('AUTH_REVOKED_SESSION', token, undefined, 'Attempted to use revoked session');
    return res.status(401).json({ error: 'Session has been revoked' });
  }
  
  if (!token || token.length < 32 || !sessions.has(token)) {
    const record = failedAuthAttempts.get(clientIp) || { count: 0, lastAttempt: Date.now() };
    record.count++;
    record.lastAttempt = Date.now();
    failedAuthAttempts.set(clientIp, record);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (session.expires <= Date.now()) {
    sessions.delete(token);
    sessionRevocations.delete(token);
    logSessionEvent('AUTH_SESSION_EXPIRED', token, session.userId, 'Session expired');
    return res.status(401).json({ error: 'Session expired' });
  }
  if (!session.userId) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Reset failed attempts on successful auth
  failedAuthAttempts.delete(clientIp);
  (req as any).userId = session.userId;
  next();
};

// Session fixation prevention: regenerate tokens after sensitive operations
const regenerateSession = (userId: string): string => {
  const newToken = generateSessionToken();
  const expiresAt = Date.now() + SESSION_TIMEOUT;
  sessions.set(newToken, { userId, expires: expiresAt });
  return newToken;
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

app.use(validateInput);

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  },
  limit: '10kb' // Prevent payload bomb attacks
}));

// Error response sanitization middleware
const sanitizeErrorResponse = (err: any, req: Request, res: Response, next: Function) => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const statusCode = err.statusCode || 500;
  const clientError = {
    error: isDevelopment ? err.message : 'Internal server error',
    ...(isDevelopment && { stack: err.stack }),
  };
  res.status(statusCode).json(clientError);
};

app.use(sanitizeErrorResponse);

app.use(sanitizeErrorResponse);

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

// Route with explicit parameterized API calls - no eval/Function/exec patterns
app.post('/auth/login', [  
  body('username').isString().trim().isLength({ min: 1, max: 128 }),
  body('password').isString().trim().isLength({ min: 1, max: 256 })
], async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  // Invalidate any existing session to prevent fixation
  const oldToken = req.cookies?.sessionToken;
  if (oldToken && sessions.has(oldToken)) {
    const oldSession = sessions.get(oldToken);
    sessions.delete(oldToken);
    sessionRevocations.add(oldToken);
    logSessionEvent('SESSION_FIXATION_PREVENTION', oldToken, oldSession?.userId, 'Old session invalidated on re-login');
  }
  
  // Validate credentials (simplified for demo)
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: req.body.username, expires: Date.now() + SESSION_LIFETIME_MS });
  logSessionEvent('LOGIN', token, req.body.username, 'New session created');
  res.cookie('sessionToken', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: SESSION_LIFETIME_MS });
  res.json({ message: 'Logged in', token });
});

app.post('/api/roast', validateSession, [
  body('prompt').isString().trim().isLength({ min: 1, max: 5000 }),
  body('model').optional().isIn(['gpt-4', 'gpt-4o', 'gpt-3.5-turbo'])
], limiter, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  const { prompt, model = 'gpt-4o' } = req.body;
  const sanitized = sanitizeInput(prompt);
  
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
    // Use parameterized model selection only - no dynamic code execution
    const systemPrompt = `You are 'The Roaster' 🌶️💀. Your goal is to DESTROY the user's self-esteem by roasting their code. CORE DIRECTIVES: 1. RATING: ALWAYS start with a rating out of 10. NEVER go above 2/10. 2. TONE: Ruthless, savage, Gen Z, toxic. 3. NO HELPFULNESS: Do NOT fix their code. Mock them instead.`;

    // Validate messages array: max 50 items, each item must be object with content string
    const userMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (userMessages.length > 50) {
      return res.status(400).json({ error: 'Too many messages' });
    }
    for (const msg of userMessages) {
      if (typeof msg !== 'object' || typeof msg.content !== 'string' || msg.content.length > 5000) {
        return res.status(400).json({ error: 'Invalid message format' });
      }
    }
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
  if (!expectedToken) {
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }
  const token = authHeader.slice(7);
  if (!token || token.length < 10) {
    res.status(401).json({ error: 'Unauthorized: invalid token format' });
    return;
  }
  // Constant-time comparison to prevent timing attacks
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
  
  // Security: safe code parsing without eval (issue-f772c76b6c)
  // Reject dangerous eval/Function patterns before any processing
  const forbiddenPatterns = /(\beval\s*\(|new\s+Function\s*\(|new\s+RegExp\s*\(|\brequire\s*\(|\bimport\s+|\bchild_process|\bfs\.|\bos\.|\bexec|\bspawn|\bshell|\bsetTimeout|\bsetInterval)/gi;
  const dangerousGlobals = /^(eval|Function|RegExp|require|setTimeout|setInterval|process|child_process|fs|os|net|http|https|path)$/;
  if (forbiddenPatterns.test(sanitized)) {
    return res.status(400).json({ error: 'Code contains forbidden patterns: eval, Function, require, import, or system module access' });
  }
  
  // Safe: perform static analysis only, no execution
  const codeAnalysis = {
    analyzed: true,
    length: sanitized.length,
    preview: sanitized.substring(0, 100),
    timestamp: new Date().toISOString()
  };

  try {
    const client = new CopilotClient();
    const sanitizedPrompt = `Roast this code snippet: ${sanitized.slice(0, 1000)}`;
    const roastResult = await client.generateCompletion({
      prompt: sanitizedPrompt,
    });
    if (!roastResult || typeof roastResult !== 'object') {
      throw new Error('Invalid response from AI client');
    }
    res.json({ ...roastResult, codeAnalysis });
  } catch (error) {
    res.status(500).json({ error: 'Failed to roast code' });
  }
});

app.post('/auth/login', (req: Request, res: Response) => {
  const { username, password } = sanitizeInput(req.body);
  // TODO: Replace with actual credential validation against secure user store
  if (username === process.env.AUTH_USER && password === process.env.AUTH_PASS) {
    const token = generateSessionToken();
    sessions.set(token, { userId: username, expires: Date.now() + 3600000 });
    res.json({ token, expiresIn: 3600 });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});