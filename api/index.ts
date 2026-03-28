import app from '../src/index.js';

// Failing-path diagnostic wrapper
const diagnosticApp = (req, res, next) => {
  const startTime = Date.now();
  const originalPath = req.path || req.url;
  
  // Log incoming request for path diagnostics
  console.log(`[API] Incoming request - method: ${req.method}, path: ${originalPath}`);
  
  // Capture response events
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    if (res.statusCode >= 400) {
      console.error(`[API] Request failed - path: ${originalPath}, status: ${res.statusCode}, duration: ${duration}ms`);
    } else {
      console.log(`[API] Request succeeded - path: ${originalPath}, status: ${res.statusCode}, duration: ${duration}ms`);
    }
    return originalSend.call(this, data);
  };
  
  // Error handler
  app(req, res, (err) => {
    if (err) {
      console.error(`[API] Error on path: ${originalPath}, error:`, err.message);
      res.status(500).json({ error: 'Internal Server Error', path: originalPath });
    } else {
      next();
    }
  });
};

export default diagnosticApp;