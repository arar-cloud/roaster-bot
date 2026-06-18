import app from '../src/index.js';

if (!app) {
  throw new Error('Failed to load app from src/index.ts - module is undefined');
}

export default app;