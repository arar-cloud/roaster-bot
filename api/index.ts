import app from '../src/index.js';

// Pre-compiled app singleton export
// Prevents module re-evaluation on each Vercel serverless invocation
// Vercel calls this on every request; keeping app cached reduces cold-start latency
export default app;