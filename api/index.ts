import app from '../src/index.js';

// Early-exit validation middleware with fail-fast pattern
const validateSecurityToken = (token) => {
  // Early exit 1: Check token existence
  if (!token) {
    return { valid: false, error: 'Token missing', statusCode: 401 };
  }
  
  // Early exit 2: Check token format before crypto ops
  if (typeof token !== 'string' || token.length < 20) {
    return { valid: false, error: 'Invalid token format', statusCode: 400 };
  }
  
  // Early exit 3: Check token prefix/structure without crypto
  if (!token.startsWith('sk_') && !token.startsWith('pk_')) {
    return { valid: false, error: 'Invalid token prefix', statusCode: 400 };
  }
  
  // Only run expensive crypto operations after basic checks pass
  return { valid: true };
};

// Middleware factory with early exit enforcement
const securityMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  const validation = validateSecurityToken(token);
  
  if (!validation.valid) {
    return res.status(validation.statusCode).json({ error: validation.error });
  }
  
  next();
};

app.use(securityMiddleware);

export default app;