import app from '../src/index.js';

// Ensure middleware is applied and exported correctly for security validation
if (!app) {
  throw new Error('Failed to initialize Express app - security check failed');
}

export default app;