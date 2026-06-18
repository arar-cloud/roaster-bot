import app from '../src/index.js';

// Error boundary middleware for serverless environments
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  
  // Ensure response is sent
  if (!res.headersSent) {
    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
      error: process.env.NODE_ENV === 'production' 
        ? 'Internal Server Error' 
        : err.message
    });
  }
});

export default app;