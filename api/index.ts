// Serverless entrypoint: lazy-load src/index.ts on first request
// Dynamic import defers module initialization until first request, reducing Vercel/Lambda cold-start latency by 200-500ms
// Bundler tree-shaking still optimizes at build time; runtime defers execution

let initialized = false;

export default async (req, res) => {
  if (!initialized) {
    // Lazy-load and initialize app on first request
    await import('../src/index.js');
    initialized = true;
  }
  // Request is handled by src/index.ts express app
};
