/**
 * API module
 * Exports the main application instance
 */
import app from '../src/index.js';

/**
 * Main application export
 * @type {any} Express/Fastify application instance
 */
export default app;

// Named export for explicit access
export { default } from '../src/index.js';
