import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Rate limiting middleware - token bucket algorithm
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;

const rateLimitMiddleware = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (!rateLimitStore.has(clientIp)) {
    rateLimitStore.set(clientIp, { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS });
  }
  
  const clientData = rateLimitStore.get(clientIp);
  
  if (now >= clientData.resetTime) {
    clientData.count = 0;
    clientData.resetTime = now + RATE_LIMIT_WINDOW_MS;
  }
  
  clientData.count++;
  
  if (clientData.count > RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.ceil((clientData.resetTime - now) / 1000);
    return res.status(429).set('Retry-After', retryAfter.toString()).json({
      error: 'Too Many Requests',
      retryAfter,
      message: 'Rate limit exceeded. Please retry after ' + retryAfter + ' seconds.'
    });
  }
  
  res.set('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS.toString());
  res.set('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX_REQUESTS - clientData.count).toString());
  next();
};

app.use(rateLimitMiddleware);

// Request/response size limit middleware
const MAX_REQUEST_BODY_SIZE = '10mb';
const MAX_RESPONSE_CHUNK_SIZE = 1048576; // 1MB per chunk

app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));
app.use(express.urlencoded({ limit: MAX_REQUEST_BODY_SIZE, extended: true }));

const sizeCheckMiddleware = (req, res, next) => {
  const originalWrite = res.write;
  const originalEnd = res.end;
  let chunkCount = 0;
  
  res.write = function(...args) {
    chunkCount++;
    if (chunkCount * MAX_RESPONSE_CHUNK_SIZE > 52428800) { // 50MB total limit
      res.statusCode = 413;
      res.end(JSON.stringify({ error: 'Response Payload Too Large' }));
      return false;
    }
    return originalWrite.apply(res, args);
  };
  
  res.end = function(...args) {
    return originalEnd.apply(res, args);
  };
  
  next();
};

app.use(sizeCheckMiddleware);

// Import actual app from src
const actualApp = (await import('../src/index.js')).default;
if (actualApp) {
  app.use(actualApp);
}

export default app;