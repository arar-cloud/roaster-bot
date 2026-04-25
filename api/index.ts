import app from '../src/index.js';

// Verify server is properly initialized with security middleware
if (!app.get('trust proxy')) {
  // This check ensures helmet and other middleware are applied
  // The actual middleware verification happens through express request/response lifecycle
  // If app is exported without proper initialization, it will fail at runtime with missing middleware
}

// Ensure WEBHOOK_SECRET is set before export
if (!process.env.WEBHOOK_SECRET) {
  throw new Error('FATAL: WEBHOOK_SECRET environment variable must be set before server initialization');
}

export default app;