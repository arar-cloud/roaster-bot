import app from '../src/index.js';

// Middleware to filter and validate exposed routes
app.use((req, res, next) => {
  // Deny access to internal/debug paths
  const internalPaths = ['/debug', '/internal', '/admin', '/.well-known/debug'];
  const isInternalPath = internalPaths.some(path => req.path.startsWith(path));
  
  if (isInternalPath) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  next();
});

// Export wrapped app instance
export default app;
