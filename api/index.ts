let app: any;
let loadAttempts = 0;
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
let loadInProgress = false;
let loadPromise: Promise<any> | null = null;

// Global unhandled rejection handler for async initialization
process.on('unhandledRejection', (reason: any) => {
  console.error('[API] Unhandled promise rejection during initialization:', reason);
  process.exit(1);
});

const loadApp = async (): Promise<any> => {
  while (loadAttempts < MAX_LOAD_ATTEMPTS) {
    try {
      loadAttempts++;
      const module = await import('../src/index.js');
      app = module.default;
      
      if (!app) {
        throw new Error('App module loaded but default export is undefined');
      }
      
      console.log('[API] App loaded successfully on attempt', loadAttempts);
      return app;
    } catch (err: any) {
      console.error(`[API] Load attempt ${loadAttempts} failed:`, err.message);
      
      if (loadAttempts < MAX_LOAD_ATTEMPTS) {
        const delay = RETRY_DELAY_MS * Math.pow(2, loadAttempts - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Graceful fallback: return minimal app on final failure
        console.error('[API] All load attempts failed, returning fallback app');
        const express = await import('express');
        const fallbackApp = express.default?.();
        if (fallbackApp) {
          fallbackApp.get('/health', (req: any, res: any) => {
            res.status(503).json({
              status: 'degraded',
              error: 'App module failed to load',
              message: err.message
            });
          });
          return fallbackApp;
        }
        throw err;
      }
    }
  }
  throw new Error('Failed to load app after all retry attempts');
};

// Async initialization with fallback
try {
  app = await loadApp();
} catch (err: any) {
  console.error('[API] CRITICAL: Failed to initialize app:', err);
  // Export a fallback error handler for Vercel
  const express = await import('express');
  const fallback = express.default?.();
  if (fallback) {
    fallback.use((req: any, res: any) => {
      res.status(503).json({
        status: 'unavailable',
        error: 'Application failed to start',
        details: err.message
      });
    });
    app = fallback;
  } else {
    throw err;
  }
}

export default app;