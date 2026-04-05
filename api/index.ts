import app from '../src/index.js';

// Validate app module is properly initialized
if (!app) {
  const errorMsg = 'Failed to initialize Express app from src/index.js - app module is null or undefined';
  console.error(`[INIT-ERROR] ${errorMsg}`);
  throw new Error(errorMsg);
}

// Comprehensive error handling middleware
app.use((err, req, res, next) => {
  console.error('API Error:', err.message, err.stack);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({ 
    error: err.message || 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Request validation wrapper
function validateRequest(req, res, next) {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    next();
  } catch (validationError) {
    console.error('Validation Error:', validationError.message);
    res.status(400).json({ error: 'Invalid Request', details: validationError.message });
  }
}

app.use(validateRequest);

// Log successful initialization
console.log('[INIT-SUCCESS] API module initialized successfully');

export default app;