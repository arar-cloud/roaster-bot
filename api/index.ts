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
  // Deduplicate concurrent initialization attempts
  if (loadInProgress) {
    console.info('[API] Load already in progress, returning pending promise');
    return loadPromise!;
  }
  
  loadInProgress = true;
  loadPromise = (async () => {
    while (loadAttempts < MAX_LOAD_ATTEMPTS) {
      try {
        loadAttempts++;
        const module = await import('../src/index.js');
        app = module.default;
        
        // Fast-fail on non-transient validation errors (non-retryable)
        if (!app) {
          const validationErr = new Error('App module loaded but default export is undefined');
          (validationErr as any).retryable = false;
          throw validationErr;
        }
        
        console.log('[API] App loaded successfully on attempt', loadAttempts);
        return app;
      } catch (err: any) {
        const isRetryable = err.retryable !== false && (err.code === 'ENOENT' || err.code === 'ENOTFOUND' || err.message?.includes('Cannot find module'));
        const logEntry = {
          timestamp: new Date().toISOString(),
          level: 'error',
          component: 'api.loadApp',
          attempt: loadAttempts,
          maxAttempts: MAX_LOAD_ATTEMPTS,
          isRetryable,
          errorCode: err.code,
          errorMessage: err.message
        };
        
        if (!isRetryable) {
          logEntry.level = 'error';
          console.error(JSON.stringify(logEntry), '(non-retryable, failing fast)');
          throw err;
        }
        
        console.error(JSON.stringify(logEntry));
        
        if (loadAttempts < MAX_LOAD_ATTEMPTS) {
          const delay = RETRY_DELAY_MS * Math.pow(2, loadAttempts - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Graceful fallback: return minimal app on final failure
          const fallbackLog = {
            timestamp: new Date().toISOString(),
            level: 'warn',
            component: 'api.loadApp',
            message: 'All load attempts exhausted, activating fallback',
            attempts: loadAttempts
          };
          console.error(JSON.stringify(fallbackLog));
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
  })();
  return loadPromise;
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