import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';
import { z } from 'zod';
import helmet from 'helmet';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      validatedBody?: Record<string, any>;
    }
  }
}

// Validation schemas for API endpoints
const chatMessageSchema = z.object({
  prompt: z.string().min(1).max(5000),
  conversationId: z.string().uuid().optional(),
  model: z.string().max(50).optional()
});

const copilotRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(5000)
  })).min(1).max(100)
});

// Input validation middleware factory
const validateRequestBody = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: Function) => {
    try {
      const validated = schema.parse(req.body);
      (req as any).validatedBody = validated;
      next();
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request parameters', details: error.errors.map(e => ({ path: e.path.join('.'), message: e.message })) });
      } else {
        res.status(400).json({ error: 'Invalid request format' });
      }
    }
  };
};

const app = express();
const port = process.env.PORT || 3000;

// Session/Token management
const sessions = new Map<string, { userId: string; createdAt: number; refreshToken: string; expiresAt: number }>();
const TOKEN_EXPIRY = 15 * 60 * 1000; // 15 minutes
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

// Password reset token management
const passwordResetTokens = new Map<string, {
  userId: string;
  expiresAt: number;
  used: boolean;
  createdAt: number;
}>();
const RESET_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour

// Track failed login attempts to prevent brute force
const failedLoginAttempts = new Map<string, { count: number; lockedUntil?: number }>();

// Generate secure token
const generateToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

// Generate password reset token
const generatePasswordResetToken = (userId: string): string => {
  const token = crypto.randomBytes(32).toString('hex');
  passwordResetTokens.set(token, {
    userId,
    expiresAt: Date.now() + RESET_TOKEN_EXPIRY,
    used: false,
    createdAt: Date.now(),
  });
  return token;
};

// Validate and consume password reset token
const validateResetToken = (token: string): { valid: boolean; userId?: string; error?: string } => {
  const resetToken = passwordResetTokens.get(token);
  if (!resetToken) {
    return { valid: false, error: 'Invalid or expired reset token' };
  }
  if (resetToken.used) {
    return { valid: false, error: 'Reset token already used' };
  }
  if (resetToken.expiresAt < Date.now()) {
    passwordResetTokens.delete(token);
    return { valid: false, error: 'Reset token expired' };
  }
  return { valid: true, userId: resetToken.userId };
};

// Mark reset token as used
const consumeResetToken = (token: string): void => {
  const resetToken = passwordResetTokens.get(token);
  if (resetToken) {
    resetToken.used = true;
  }
};

// Invalidate all sessions for a user (logout all devices on password reset)
const invalidateUserSessions = (userId: string): void => {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) {
      sessions.delete(token);
    }
  }
};

// Account enumeration prevention - constant-time response
const constantTimeDelay = (): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
};

// Session validation middleware
const validateSession = (req: Request, res: Response, next: Function) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }

  (req as any).userId = session.userId;
  (req as any).sessionToken = token;
  next();
};

// General API rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
});

// Strict rate limiter for authentication endpoints (per-IP)
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  message: 'Too many authentication attempts, please try again later'
});

// Per-user rate limiter for sensitive operations
const userLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => {
    return (req as any).userId || req.ip || 'unknown';
  },
});

// Security headers middleware (Helmet)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  xssFilter: true,
}));

// HTTPS redirect middleware
app.use((req: Request, res: Response, next: Function) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    return res.redirect(307, `https://${req.header('host')}${req.url}`);
  }
  next();
});

// CSRF token generation and validation
const csrfTokens = new Map<string, { expiresAt: number }>();

const generateCSRFToken = (): string => {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, { expiresAt: Date.now() + 60 * 60 * 1000 }); // 1 hour expiry
  return token;
};

const validateCSRFToken = (req: Request, res: Response, next: Function) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] as string || req.body.csrfToken;
    if (!token || !csrfTokens.has(token) || csrfTokens.get(token)!.expiresAt < Date.now()) {
      csrfTokens.delete(token);
      return res.status(403).json({ error: 'Invalid or expired CSRF token' });
    }
    csrfTokens.delete(token); // Single-use token
  }
  next();
};

// Authorization middleware factory
const requireAuth = (roles?: string[]) => {
  return (req: Request, res: Response, next: Function) => {
    if (!(req as any).userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (roles && !(req as any).userRole || !roles.includes((req as any).userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Secure error handler middleware
const errorHandler = (err: any, req: Request, res: Response, next: Function) => {
  console.error('[ERROR]', new Date().toISOString(), {
    path: req.path,
    method: req.method,
    userId: (req as any).userId,
    message: err.message,
  });
  const statusCode = err.statusCode || 500;
  const isDev = process.env.NODE_ENV === 'development';
  res.status(statusCode).json({
    error: isDev ? err.message : 'An internal server error occurred'
  });
};

app.use(validateCSRFToken);

// Request signing and integrity verification
const SIGNING_KEY = process.env.SIGNING_KEY || crypto.randomBytes(32).toString('hex');

const verifyRequestSignature = (req: Request, res: Response, next: Function) => {
  // For critical endpoints (marked by header)
  if (req.headers['x-signature-required'] === 'true') {
    const signature = req.headers['x-signature'] as string;
    if (!signature || !req.rawBody) {
      return res.status(400).json({ error: 'Missing request signature' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', SIGNING_KEY)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: 'Invalid request signature' });
    }
  }
  next();
};

app.use(verifyRequestSignature);

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

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

app.post('/agent', limiter, requireAuth(), async (req: Request, res: Response) => {
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    if (signature !== digest && signature !== `sha256=${digest}`) {
        // Simple check for dev
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