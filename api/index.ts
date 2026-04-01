import app from '../src/index.js';

// Security: Ensure app exports properly configured with security middleware
if (!app) {
  throw new Error('Failed to initialize app - security middleware may not be configured');
}

export default app;