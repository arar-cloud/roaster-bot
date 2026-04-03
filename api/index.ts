/**
 * api/index.ts — Vercel/serverless entry point for roaster-bot.
 *
 * Wraps the app import with startup diagnostics so that initialization
 * failures in src/index.ts surface immediately rather than being masked
 * by a silent re-export.
 *
 * Fixes:
 *   - issue-bb09437843: bare re-export lacked error handling
 *   - issue-fd44e12818: failing-path diagnostics missing from api entry
 */

import { createRequire } from 'module';

// Catch any synchronous or asynchronous errors that occur during module
// initialization of src/index.ts before the export is consumed by the
// serverless runtime.
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  console.error(
    JSON.stringify({
      level: 'fatal',
      source: 'api/index.ts',
      event: 'unhandledRejection',
      message,
      stack,
      timestamp: new Date().toISOString(),
    })
  );
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      source: 'api/index.ts',
      event: 'uncaughtException',
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    })
  );
  process.exit(1);
});

let app: unknown;

try {
  // Dynamic import allows us to catch synchronous top-level errors from
  // the src module (e.g. missing env vars, bad config) and emit a
  // structured diagnostic before the process crashes silently.
  const mod = await import('../src/index.js');
  app = mod.default;

  if (!app) {
    throw new Error(
      'src/index.ts did not export a default Express app. ' +
      'Check that `export default app` exists in src/index.ts.'
    );
  }

  console.log(
    JSON.stringify({
      level: 'info',
      source: 'api/index.ts',
      event: 'startup',
      message: 'Express app loaded successfully',
      timestamp: new Date().toISOString(),
    })
  );
} catch (err: unknown) {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(
    JSON.stringify({
      level: 'fatal',
      source: 'api/index.ts',
      event: 'startup_failure',
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
  );
  // Exit with a non-zero code so process supervisors and serverless
  // platforms treat this as a hard failure instead of returning a
  // silent 500 with no traceable cause.
  process.exit(1);
}

export default app;
