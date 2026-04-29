// Serverless entrypoint: direct import from src/index.ts
// Eliminates re-export indirection to reduce cold-start latency in Vercel serverless context
import '../src/index.js';
