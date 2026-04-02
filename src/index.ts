import 'dotenv/config';
import { body, validationResult } from 'express-validator';

// Input validation helpers
const sanitizeInput = (input: string): string => {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .slice(0, 10000) // Max 10KB
    .replace(/[<>"']/g, (char) => {
      const escapeMap: { [key: string]: string } = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return escapeMap[char] || char;
    });
};

const validateUserId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id) && id.length < 256;

// Session token management
const SESSION_TIMEOUT = 3600000; // 1 hour
const activeSessions = new Map();

interface SessionData {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

const generateSessionToken = (userId: string): string => {
  const token = Buffer.from(`${userId}:${Date.now()}:${Math.random()}`).toString('base64');
  const session: SessionData = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TIMEOUT
  };
  activeSessions.set(token, session);
  return token;
};

const validateSessionToken = (token: string): SessionData | null => {
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
};

// Auth middleware
const authMiddleware = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token || !validateSessionToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.session = validateSessionToken(token);
  next();
};import express, { Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { CopilotClient } from '@github/copilot-sdk';
import { body, validationResult } from 'express-validator';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();

app.use(helmet());

// Security headers middleware
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Authentication middleware
const validateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const validToken = process.env.API_TOKEN;
  
  if (!token || token !== validToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Safe operation dispatcher - no eval, no dynamic code execution
const executeOperation = (operation: string, params: Record<string, any>): Promise<any> => {
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(`Operation not allowed: ${operation}`);
  }
  
  switch (operation) {
    case 'copilot_suggest':
      return handleCopilotSuggest(params);
    case 'copilot_explain':
      return handleCopilotExplain(params);
    case 'openai_complete':
      return handleOpenAIComplete(params);
    default:
      throw new Error('Unknown operation');
  }
};

const handleCopilotSuggest = async (params: any) => {
  // Safe implementation without eval
  return { suggestion: 'Safe suggestion' };
};

const handleCopilotExplain = async (params: any) => {
  // Safe implementation without eval
  return { explanation: 'Safe explanation' };
};

const handleOpenAIComplete = async (params: any) => {
  // Safe implementation without eval
  return { completion: 'Safe completion' };
};

// Whitelist of allowed API operations
const ALLOWED_OPERATIONS = new Set([
  'copilot_suggest',
  'copilot_explain',
  'openai_complete'
]);
const port = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({
  limit: '1mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ limit: '1mb', extended: false }));

// Input validation middleware for code submission
app.use((req: Request, res: Response, next) => {
  if (req.method === 'POST' && req.body?.code) {
    const code = req.body.code;
    if (typeof code !== 'string') {
      return res.status(400).json({ error: 'Invalid input: code must be a string' });
    }
    if (code.length > 10000) {
      return res.status(413).json({ error: 'Input too large: code exceeds 10KB limit' });
    }
    // Reject code with dangerous patterns
    if (/require\s*\(|import\s+|eval\s*\(|Function\s*\(/i.test(code)) {
      return res.status(400).json({ error: 'Invalid input: dangerous patterns detected' });
    }
  }
  next();
});

// Express validator middleware - validate and sanitize request bodies
const validateMessagePayload = [
  body('messages').optional().isArray().withMessage('Messages must be an array'),
  body('messages.*.content').optional().isString().trim().isLength({ max: 4000 }).withMessage('Message content must be ≤4000 chars'),
  body('messages.*.role').optional().isIn(['user', 'assistant']).withMessage('Invalid message role'),
];

const validateInput = (req: Request, res: Response, next: any) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

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

app.post('/agent', limiter, validateToken, async (req: Request, res: Response) => {
  // Input validation for request body
  const userMessages = req.body.messages;
  if (!Array.isArray(userMessages)) {
    return res.status(400).json({ error: 'Invalid request: messages must be an array' });
  }
  
  // Webhook signature verification
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    const rawBody = req.rawBody;
    if (!rawBody) return res.status(400).send('Missing raw body.');

    if (typeof signature !== 'string') {
      return res.status(400).send('Invalid signature header type.');
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

    try {
      // Ensure both buffers have equal length to prevent timing attacks
      if (signature.length !== digest.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
        return res.status(401).send('Invalid signature.');
      }
    } catch (err) {
      return res.status(401).send('Signature verification failed.');
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

    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    if (!lastMessage || typeof lastMessage.content !== 'string') {
      return res.status(400).json({ error: 'Invalid message: no valid user message found' });
    }
    
    let prompt = lastMessage.content.trim();
    if (prompt.length === 0 || prompt.length > 4000) {
      return res.status(400).json({ error: 'Invalid message: payload must be 1-4000 characters' });
    }
    // Sanitize dangerous patterns - prevent code injection and command execution
    // Block eval, exec, Function, require, and import patterns
    prompt = prompt
      .replace(/```[\s\S]*?```/g, '[CODE_BLOCK]')
      .replace(/eval\s*\(/gi, 'BLOCKED_EVAL(')
      .replace(/exec\s*\(/gi, 'BLOCKED_EXEC(')
      .replace(/Function\s*\(/gi, 'BLOCKED_FUNCTION(')
      .replace(/require\s*\(/gi, 'BLOCKED_REQUIRE(')
      .replace(/import\s*\(/gi, 'BLOCKED_IMPORT(')
      .trim();

    // Enforce input bounds for AI prompt to prevent payload attacks
    const basePrompt = 'Roast this GitHub comment: ';
    if (basePrompt.length + prompt.length > 2000) {
      return res.status(400).json({ error: 'Payload exceeds safe limits' });
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
      if (event.type === "assistant.message_delta") {
        const chunk = {
          choices: [{ delta: { content: event.data.deltaContent } }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    });

    let fullCompletion = '';
    session.on((event: any) => {
      if (event.type === "assistant.message_delta") {
        fullCompletion += event.data.deltaContent;
      }
    });

    await session.sendAndWait({ prompt, maxTokens: 256 });

    // Sanitize AI completion output to strip dangerous patterns and prevent code injection
    const sanitizedRoast = fullCompletion
      .replace(/```[\s\S]*?```/g, '[CODE_BLOCK]')
      .replace(/eval\(/gi, 'BLOCKED_EVAL(')
      .replace(/exec\(/gi, 'BLOCKED_EXEC(')
      .replace(/Function\(/gi, 'BLOCKED_FUNCTION(')
      .replace(/require\(/gi, 'BLOCKED_REQUIRE(')
      .replace(/import\(/gi, 'BLOCKED_IMPORT(')
      .substring(0, 1000);

    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: sanitizedRoast } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error processing webhook:', error);
    if (!res.headersSent) res.status(500).send('Internal server error');
  } finally {
    await client.stop();
  }
});

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});