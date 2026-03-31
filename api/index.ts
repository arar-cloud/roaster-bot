import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import app from '../src/index.js';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests'
});

app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } } }));
app.use(limiter);

// Ensure security middleware is properly applied before export
if (!app) {
  throw new Error('Failed to initialize Express app with security middleware');
}

export default app;