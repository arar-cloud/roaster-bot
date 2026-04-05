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

// Fixed mobile API endpoints with proper format handling
function processData(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (e) {
      return data;
    }
  }
  return data;
}

app.post('/api/mobile/endpoint', validateRequest, async (req, res) => {
  try {
    const { userId, data } = req.body;
    
    if (!userId || !data) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['userId', 'data'] 
      });
    }
    
    // Consistent response format for mobile
    const response = {
      status: 'success',
      data: processData(data),
      timestamp: new Date().toISOString(),
      version: '1.0'
    };
    
    res.status(200).json(response);
  } catch (error) {
    console.error('Mobile endpoint error:', error);
    res.status(500).json({ 
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Log successful initialization
console.log('[INIT-SUCCESS] API module initialized successfully');

export default app;