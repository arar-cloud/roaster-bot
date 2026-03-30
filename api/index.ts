import app from '../src/index.js';

// Error handling wrapper for diagnostics
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[API-ERROR]', {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    status: err.status || 500,
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    path: req.path
  });
});

// Request logging middleware
app.use((req: any, res: any, next: any) => {
  console.log('[API-REQUEST]', {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: req.query
  });
  next();
});

export default app;