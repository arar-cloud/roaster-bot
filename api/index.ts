import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Timeout configuration for external HTTP calls
const HTTP_TIMEOUT_MS = 30000; // 30 seconds
const SOCKET_TIMEOUT_MS = 60000; // 60 seconds
const CONNECT_TIMEOUT_MS = 10000; // 10 seconds

// Configure HTTP/HTTPS agents with timeout
const httpAgent = new http.Agent({
  timeout: SOCKET_TIMEOUT_MS,
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const httpsAgent = new https.Agent({
  timeout: SOCKET_TIMEOUT_MS,
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

// Request validation middleware
const validateRequest = (req, res, next) => {
  try {
    // Sanitize request headers to prevent injection
    const maxHeaderSize = 8192;
    const headerString = JSON.stringify(req.headers);
    if (headerString.length > maxHeaderSize) {
      return res.status(400).json({ error: 'Headers exceed maximum size' });
    }
    
    // Validate Content-Type for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('Content-Type') || '';
      if (!contentType.includes('application/json') && req.body && Object.keys(req.body).length > 0) {
        return res.status(415).json({ error: 'Unsupported Media Type' });
      }
    }
    
    // Validate request body size
    const maxBodySize = 1048576; // 1MB
    if (req.headers['content-length'] && parseInt(req.headers['content-length']) > maxBodySize) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    
    next();
  } catch (error) {
    res.status(400).json({ error: 'Invalid request', details: error.message });
  }
};

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

// Error logging utility
const logError = (requestId, error, context = {}) => {
  const timestamp = new Date().toISOString();
  const errorLog = {
    timestamp,
    requestId,
    error: error.message,
    stack: error.stack,
    context,
  };
  console.error('[ERROR]', JSON.stringify(errorLog));
  return errorLog;
};

// Request tracking middleware
const requestTracking = (req, res, next) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.id = requestId;
  res.set('X-Request-ID', requestId);
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`[REQUEST] ${requestId} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  
  next();
};

app.use(rateLimitMiddleware);
app.use(requestTracking);

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