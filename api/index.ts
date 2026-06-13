import app from '../src/index.js';

// Global error handler to catch unhandled errors
app.use((err: any, req: any, res: any, next: any) => {
  const errorMessage = err instanceof Error ? err.message : 'Unknown error';
  const errorType = err?.name || 'Error';
  console.error(`[UNHANDLED_ERROR] type=${errorType}, message=${errorMessage}, timestamp=${new Date().toISOString()}`);
  // Do not expose stack trace or internal details in logs
  res.status(500).json({ error: 'Internal server error' });
});

export default app;