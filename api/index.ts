// API entry point - verify the app instance is properly hardened
import app from '../src/index.js';

// Ensure only the hardened app instance is exported
// Do not modify or extend this app instance further
// All security middleware must be applied in src/index.ts

export default app;
