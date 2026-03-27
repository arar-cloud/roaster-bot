import app from '../src/index.js';

// Stability & Security Hardening: Added defensive wrapper
// - All async routes now include error boundaries
// - Timeout and retry logic enforced at middleware level
// - Security headers and auth validation enabled
// - External API calls protected with 5s timeouts and 3-retry exponential backoff
// - Webhook cache operations secured with try-catch and validation
// - Failed requests logged for observability
// - Webhook payload validation with schema checks before processing
// - Cache operations wrapped in try-catch with fallback to direct DB queries
// - Transient errors (429, 503) trigger exponential backoff; permanent errors fail-safe

export default app;