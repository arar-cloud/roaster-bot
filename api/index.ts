import app from '../src/index.js';

// Request validation middleware
app.use((req: any, res: any, next: any) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!req.headers['content-type'] || !req.headers['content-type'].includes('application/json')) {
      return res.status(400).json({
        error: 'Invalid Content-Type. Expected application/json',
        status: 400
      });
    }
  }
  next();
});

// Global error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    status: err.status || 500
  });
});

export default app;