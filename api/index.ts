import app from '../src/index.js';

// Export app for Vercel serverless environment
// All security middleware (helmet, rate limiting, CSRF, auth) is applied in src/index.ts
export default app;
