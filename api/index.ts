import app from '../src/index.js';

// Middleware for query optimization and caching
app.use((req, res, next) => {
  // Enable response caching for GET requests
  if (req.method === 'GET') {
    res.set('Cache-Control', 'public, max-age=300');
  }
  next();
});

// Middleware to prevent memory leaks: cleanup request-scoped resources
app.use((req, res, next) => {
  // Clear any accumulated query results to prevent memory growth
  res.on('finish', () => {
    req.queryCache = null;
  });
  next();
});

export default app;