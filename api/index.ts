import app from '../src/index.js';

// Ensure critical env vars are present on startup
const requiredEnvVars = ['GITHUB_TOKEN', 'OPENAI_API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export default app;