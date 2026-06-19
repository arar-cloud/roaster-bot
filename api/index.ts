import app from '../src/index.js';

// Validate that app is a valid Express application
if (!app || typeof app !== 'object' || typeof app.listen !== 'function') {
  throw new Error('Failed to import valid Express app from src/index.ts');
}

export default app;