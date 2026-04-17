// Re-export the async-compatible Express app
import app from '../src/index.js';

// Ensure proper async/await support for concurrent request handling
export default app;