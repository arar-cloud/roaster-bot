import app from '../src/index.js';

// Global error handler to catch unhandled errors
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;