import app from '../src/index.js';

// Security middleware: sanitize error responses to prevent config/auth leakage
app.use((err, req, res, next) => {
  // Never expose internal details in error messages
  const statusCode = err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Log full error server-side only
  if (!isProduction) {
    console.error('[Error]', err.message, err.stack);
  }
  
  // Return sanitized error to client
  res.status(statusCode).json({
    error: isProduction ? 'Internal server error' : err.message,
    // Never include: stack traces, secrets, config paths, or internal system details
  });
});

// Block attempts to access environment variables via query params or headers
app.use((req, res, next) => {
  // Reject requests that look like config/env scanning attempts
  const suspiciousPatterns = ['env', 'process', 'config', 'secret', 'api_key', 'token'];
  const allInputs = [
    req.query ? Object.keys(req.query).join(' ') : '',
    req.get('x-forwarded-for') || '',
    req.path
  ].join(' ').toLowerCase();
  
  if (suspiciousPatterns.some(p => allInputs.includes(p)) && req.path.includes('__')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  next();
});

export default app;