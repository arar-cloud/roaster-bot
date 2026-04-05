import app from '../src/index.js';

// Validate app module is properly initialized
if (!app) {
  const errorMsg = 'Failed to initialize Express app from src/index.js - app module is null or undefined';
  console.error(`[INIT-ERROR] ${errorMsg}`);
  throw new Error(errorMsg);
}

// Log successful initialization
console.log('[INIT-SUCCESS] API module initialized successfully');

export default app;