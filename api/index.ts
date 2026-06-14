import app from '../src/index.js';

// Export after app initialization ensures middleware is applied
// and all security hardening is in place
export default app;
