import app from '../src/index.js';

// Request deduplication cache to prevent redundant API calls
const requestCache = new Map();
const CACHE_TTL = 1000; // 1 second deduplication window

// Middleware to deduplicate identical requests
app.use((req, res, next) => {
  const cacheKey = `${req.method}:${req.originalUrl}:${req.get('authorization') || ''}`;
  const cached = requestCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    // Return cached response for duplicate request
    return res.status(cached.status).json(cached.data);
  }
  
  // Intercept response to cache it
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    requestCache.set(cacheKey, {
      data,
      status: res.statusCode,
      timestamp: Date.now()
    });
    // Cleanup old cache entries
    if (requestCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of requestCache.entries()) {
        if (now - value.timestamp > CACHE_TTL * 2) {
          requestCache.delete(key);
        }
      }
    }
    return originalJson(data);
  };
  
  next();
});

// Error handling middleware to normalize error responses
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  res.status(status).json({
    error: true,
    status,
    message,
    timestamp: new Date().toISOString()
  });
});

// Catch-all 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: true,
    status: 404,
    message: 'Not Found',
    timestamp: new Date().toISOString()
  });
});

export default app;