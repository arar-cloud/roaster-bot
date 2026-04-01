import app from '../src/index.js';

// Failing-path diagnostics middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  
  res.json = function(data) {
    console.log(`[API] ${req.method} ${req.path} - Status: ${res.statusCode} - Duration: ${Date.now() - startTime}ms`);
    return originalJson(data);
  };
  
  res.send = function(data) {
    console.log(`[API] ${req.method} ${req.path} - Status: ${res.statusCode} - Duration: ${Date.now() - startTime}ms`);
    return originalSend(data);
  };
  
  next();
});

// Global error handler for failing paths
app.use((err, req, res, next) => {
  const errorId = `ERR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const statusCode = err.statusCode || err.status || 500;
  
  console.error(`[API_ERROR] ${errorId} - ${req.method} ${req.path}`, {
    error: err.message,
    stack: err.stack,
    statusCode,
    requestBody: req.body,
    query: req.query,
    timestamp: new Date().toISOString()
  });
  
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
    errorId,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Catch unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION]', { reason, promise });
});

export default app;