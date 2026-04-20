// Input validation middleware
const validateInput = (schema) => {
  return (req, res, next) => {
    try {
      // Validate request body
      if (req.body && Object.keys(req.body).length > 0) {
        for (const [key, value] of Object.entries(req.body)) {
          if (typeof value === 'string') {
            // Sanitize string inputs: remove script tags and SQL keywords
            if (/<script[^>]*>|javascript:|onerror=|onload=|eval\(|alert\(/i.test(value)) {
              return res.status(400).json({ error: 'Invalid input detected' });
            }
            // Check for SQL injection patterns
            if (/('|(\-\-)|(;)|(\|\|)|(\*)|(<)|(>)|(\bOR\b)|(\bAND\b)|(\bUNION\b)|(\bSELECT\b)|(\bDROP\b)|(\bINSERT\b)|(\bUPDATE\b)|(\bDELETE\b))/i.test(value)) {
              return res.status(400).json({ error: 'Malicious SQL pattern detected' });
            }
          }
        }
      }
      // Validate query parameters
      for (const [key, value] of Object.entries(req.query || {})) {
        if (typeof value === 'string' && (/<script[^>]*>|javascript:|onerror=|onload=|eval\(|alert\(/i.test(value))) {
          return res.status(400).json({ error: 'Invalid query parameter' });
        }
      }
      next();
    } catch (error) {
      return res.status(400).json({ error: 'Input validation failed' });
    }
  };
};

// Rate limiting middleware to prevent brute force and DoS (issue-40bdd8439f)
const requestLog = new Map();
const rateLimitMiddleware = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 100; // Max 100 requests per minute per IP
  
  if (!requestLog.has(clientIp)) {
    requestLog.set(clientIp, []);
  }
  
  const requests = requestLog.get(clientIp);
  const recentRequests = requests.filter(timestamp => now - timestamp < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }
  
  recentRequests.push(now);
  requestLog.set(clientIp, recentRequests);
  
  // Cleanup old entries
  if (requestLog.size > 10000) {
    for (const [ip, reqs] of requestLog.entries()) {
      const valid = reqs.filter(t => now - t < windowMs);
      if (valid.length === 0) {
        requestLog.delete(ip);
      } else {
        requestLog.set(ip, valid);
      }
    }
  }
  
  next();
};

// Authorization check middleware (issue-c77040b212)
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
  }
  
  try {
    // Token validation (basic: should be implemented with JWT library in production)
    if (!token || token.length < 32) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token format' });
    }
    // Token would be validated/decoded here with proper JWT verification
    req.user = { token: token }; // Placeholder: in production, decode JWT and extract user info
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token validation failed' });
  }
};

// Authorization boundary check (issue-c77040b212)
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    // In production, extract user role from decoded JWT token
    const userRole = req.user?.role || 'guest';
    
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
};

// Error handling middleware to prevent information disclosure (issue-7ae92d25e4)
const errorHandlerMiddleware = (err, req, res, next) => {
  // Log error internally but don't expose stack trace to client
  console.error('[Internal Error]', err.message);
  
  // Generic error response to avoid information disclosure
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;
  
  res.status(statusCode).json({
    error: message,
    // Never include stack trace, query details, or system info in response
  });
};

import app from '../src/index.js';

// Apply security middleware globally
app.use(rateLimitMiddleware); // Apply rate limiting to all routes
app.use(validateInput()); // Apply input validation to all routes
app.use(errorHandlerMiddleware); // Apply error handling to catch and sanitize errors

export default app;