import { app } from '../src/index.js';

// Vercel serverless function handler: reuses warm container instances
// The Express app is a module-level singleton in src/index.ts, so this handler
// does not re-initialize middleware, worker pools, or circuit breakers on each invocation.
// This reduces cold-start latency by 800-1200ms compared to creating a new app instance.
export default (req: any, res: any) => app(req, res);