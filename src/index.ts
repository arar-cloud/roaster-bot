import 'dotenv.config()';
import crypto from 'crypto';

// Consolidated environment validation - run once at startup
const requiredEnvVars = ['GITHUB_TOKEN', 'WEBHOOK_SECRET', 'COPILOT_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Validate WEBHOOK_SECRET is a strong secret (minimum 32 chars for HMAC)
if (process.env.WEBHOOK_SECRET && process.env.WEBHOOK_SECRET.length < 32) {
  console.warn('WARNING: WEBHOOK_SECRET should be at least 32 characters for cryptographic strength');
}

// CSRF token validation middleware
function verifyCsrfToken(req: any, res: any, next: any) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] || req.body?.csrf_token;
    const sessionToken = req.session?.csrf_token;
    
    if (!token || token !== sessionToken) {
      return res.status(403).json({ error: 'CSRF token validation failed' });
    }
  }
  next();
}

// CSRF token validation middleware
function verifyCsrfToken(req: any, res: any, next: any) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] || req.body?.csrf_token;
    const sessionToken = req.session?.csrf_token;
    
    if (!token || token !== sessionToken) {
      return res.status(403).json({ error: 'CSRF token validation failed' });
    }
  }
  next();
}

// CSRF token validation middleware
function verifyCsrfToken(req: any, res: any, next: any) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] || req.body?.csrf_token;
    const sessionToken = req.session?.csrf_token;
    
    if (!token || token !== sessionToken) {
      return res.status(403).json({ error: 'CSRF token validation failed' });
    }
  }
  next();
}

// CSRF token validation middleware
function verifyCsrfToken(req: any, res: any, next: any) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.headers['x-csrf-token'] || req.body?.csrf_token;
    const sessionToken = req.session?.csrf_token;
    
    if (!token || token !== sessionToken) {
      return res.status(403).json({ error: 'CSRF token validation failed' });
    }
  }
  next();
}

// Input validation helper: sanitize and validate user input
function validateInput(input: unknown, maxLength: number = 1000): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength}`);
  }
  // Remove potentially dangerous characters
  return input.replace(/[<>"'&]/g, (char) => {
    const escapeMap: { [key: string]: string } = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '&': '&amp;'
    };
    return escapeMap[char] || char;
  });
}umber = 1000): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength}`);
  }
  // Remove potentially dangerous characters
  return input.replace(/[<>"'&]/g, (char) => {
    const escapeMap: { [key: string]: string } = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '&': '&amp;'
    };
    return escapeMap[char] || char;
  });
}umber = 1000): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength}`);
  }
  // Remove potentially dangerous characters
  return input.replace(/[<>"'&]/g, (char) => {
    const escapeMap: { [key: string]: string } = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '&': '&amp;'
    };
    return escapeMap[char] || char;
  });
}umber = 5000): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid input: expected string');
  }
  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength} characters`);
  }
  return input;
}

// Secure webhook verification using timing-safe comparison
function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) {
    throw new Error('Missing signature or secret for webhook verification');
  }
  
  try {
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    const signatureBuffer = Buffer.from(signature);
    const digestBuffer = Buffer.from(digest);
    
    if (signatureBuffer.length !== digestBuffer.length) {
      return false;
    }
    
    return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
  } catch (err) {
    console.error('Webhook signature verification error:', err);
    return false;
  }
}

// Example: Express middleware for webhook authentication (if using Express)
function webhookAuthMiddleware(req: any, res: any, next: any) {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    const payload = req.rawBody || JSON.stringify(req.body);
    
    if (!verifyWebhookSignature(payload, signature, process.env.WEBHOOK_SECRET!)) {
      return res.status(401).json({ error: 'Unauthorized: invalid webhook signature' });
    }
    next();
  } catch (err) {
    console.error('Webhook auth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Handler for GitHub webhook events
async function handleWebhook(event: any): Promise<void> {
  try {
    // Validate event object structure
    if (!event || typeof event !== 'object') {
      throw new Error('Invalid webhook event: not an object');
    }
    
    const action = validateInput(event.action || '', 100);
    const eventType = validateInput(event.type || '', 100);
    
    console.log(`Processing GitHub event: ${eventType} - ${action}`);
    // Add your event handling logic here
  } catch (err) {
    console.error('Error handling webhook:', err);
    throw err;
  }
}

export { verifyWebhookSignature, validateInput, webhookAuthMiddleware, handleWebhook };
