import app from '../src/index.js';

if (!app) {
  throw new Error('Failed to import Express app from src/index.js');
}

if (typeof app !== 'object' || app === null) {
  throw new Error('Invalid app object: expected Express application instance');
}

export default app;