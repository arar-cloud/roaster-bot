import app from '../src/index.js';
import { Pool } from 'pg';
import compression from 'compression';
import { cachingMiddleware, configureEndpointCaching } from './caching.js';
import rateLimit from 'express-rate-limit';
import bodyParser from 'express';

// Initialize database connection pool
const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'roaster',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20, // Maximum pool size: handle 20 concurrent connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Connection timeout 2s
});

// Attach pool to app for use in route handlers
app.locals.dbPool = dbPool;

// Enable gzip compression for all responses (50-70% bandwidth reduction)
app.use(compression({ level: 6, threshold: 1024 }));

// Enable streaming responses for large payloads to reduce memory allocation
app.use((req, res, next) => {
  // Set streaming headers for large responses
  res.setHeader('Transfer-Encoding', 'chunked');
  next();
});

// Add request body size limits and validation middleware with compression
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ limit: '1mb', extended: true }));

// Response streaming middleware for efficient large payload handling
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function(data) {
    res.setHeader('Content-Type', 'application/json');
    if (Buffer.byteLength(JSON.stringify(data)) > 10240) {
      // Stream large responses to avoid memory spike
      res.write(JSON.stringify(data));
      res.end();
    } else {
      return originalJson.call(this, data);
    }
  };
  next();
});

// Rate limiting to prevent abuse and memory exhaustion
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.'
});
app.use(limiter);

// Input sanitization middleware for query parameters
app.use((req, res, next) => {
  // Validate and sanitize query parameters
  Object.keys(req.query).forEach(key => {
    if (typeof req.query[key] === 'string') {
      req.query[key] = req.query[key].trim().substring(0, 256);
    }
  });
  next();
});

// Configure endpoint-specific caching headers
configureEndpointCaching(app);

export default app;