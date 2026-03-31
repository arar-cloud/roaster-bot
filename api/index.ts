import app from '../src/index.js';

// Add request logging middleware for failing-path diagnostics
app.use((req, res, next) => {
  const startTime = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    console.log(`[API] ${req.method} ${req.path} - Status: ${statusCode} - Duration: ${duration}ms`);
    if (statusCode >= 400) {
      console.error(`[API_ERROR] ${req.method} ${req.path} - ${statusCode} - ${data}`);
    }
    return originalSend.call(this, data);
  };
  next();
});

// Add error handling middleware for unhandled exceptions
app.use((err, req, res, next) => {
  console.error(`[API_UNHANDLED_ERROR] ${req.method} ${req.path}:`, err.message, err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

export default app;