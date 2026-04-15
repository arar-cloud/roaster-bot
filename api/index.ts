import app from '../src/index.js';
import express, { Request, Response, NextFunction } from 'express';

// Token-bucket rate limiter to prevent DoS and reduce server load
interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_TOKENS = 100;
const TOKENS_PER_MINUTE = 100;
const REFILL_INTERVAL = 60000; // 1 minute in ms

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  let entry = rateLimitStore.get(clientIp);

  if (!entry) {
    rateLimitStore.set(clientIp, { tokens: MAX_TOKENS - 1, lastRefill: now });
    return false;
  }

  const timePassed = now - entry.lastRefill;
  const tokensToAdd = (timePassed / REFILL_INTERVAL) * TOKENS_PER_MINUTE;
  entry.tokens = Math.min(MAX_TOKENS, entry.tokens + tokensToAdd);
  entry.lastRefill = now;

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return false;
  }
  return true;
}

const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.status(429).json({ error: 'Too many requests. Rate limit exceeded.' });
    return;
  }
  next();
};

// Apply rate limiting to all routes
app.use(rateLimitMiddleware);

export default app;