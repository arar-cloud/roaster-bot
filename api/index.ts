import app from '../src/index.js';

// Validate that app is properly initialized
if (!app) {
  throw new Error('Failed to initialize Express app from src/index.ts');
}

// Error boundary for serverless handler invocation
try {
  // Ensure app is an Express application with expected methods
  if (typeof app !== 'object' || typeof (app as any).get !== 'function') {
    throw new Error('App is not a valid Express application instance');
  }
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.error('App initialization error boundary caught:', errorMsg);
  // Re-throw to prevent Vercel from deploying broken code
  throw error;
}

// Safe export for Vercel serverless environment
export default app;