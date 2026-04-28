import app from '../src/index.js';

// Vercel serverless function handler: enables warm container reuse and fast cold starts
export default (req: any, res: any) => app(req, res);