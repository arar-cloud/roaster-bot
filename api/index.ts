import app from '../src/app.js';

if (!app) {
  throw new Error('Failed to load app from ../src/app.js: default export not found');
}

export default app;