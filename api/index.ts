import app from '../src/index.js';
import { validateAuthEnv } from './env.js';

// Validate auth environment at startup
if (!validateAuthEnv()) {
  throw new Error('[SECURITY] Authentication environment validation failed');
}

export default app;