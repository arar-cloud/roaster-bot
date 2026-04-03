import app from '../src/index.js';

// Validate critical environment variables at startup
const requiredEnvVars = ['OPENAI_API_KEY', 'GITHUB_COPILOT_API_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Enforce security headers and HTTPS policy
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  if (process.env.NODE_ENV === 'production') {
    if (req.protocol !== 'https') {
      return res.status(403).json({ error: 'HTTPS required' });
    }
  }
  next();
});

// Set secure cookie defaults
app.use((req, res, next) => {
  const originalCookie = res.cookie.bind(res);
  res.cookie = function(name, val, options = {}) {
    options.httpOnly = true;
    options.secure = process.env.NODE_ENV === 'production';
    options.sameSite = 'Strict';
    return originalCookie(name, val, options);
  };
  next();
});

// Set request timeout to prevent hanging connections (stability:issue-9c120bcb62)
app.use((req, res, next) => {
  req.setTimeout(30000); // 30 seconds
  res.setTimeout(30000);
  next();
});

export default app;