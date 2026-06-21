import app from '../src/index.js';

// Error boundary: ensure initialization errors are caught and logged
if (!app || typeof app !== 'object') {
  throw new Error('Failed to initialize Express app from src/index.ts');
}

// Verify app is a valid Express instance with required methods
if (typeof app.listen !== 'function') {
  throw new Error('Invalid app export: missing Express handler');
}

// Add global error handler as final middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error in Express app:', err);
  const errorResponse: any = {
    error: 'Internal server error',
    message: err?.message || 'Unknown error',
  };
  if (process.env.NODE_ENV === 'development' && err?.stack) {
    errorResponse.stack = err.stack;
  }
  res.status(500).json(errorResponse);
});

export default app;
