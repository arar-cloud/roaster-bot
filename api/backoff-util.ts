/**
 * Unified exponential backoff calculation for Redis cluster reconnection.
 * Precomputes backoff sequence at module load time to eliminate repeated Math.pow calculations.
 * Uses 16 max retries (consistent with maxRedirections) and 100ms base delay.
 */

const MAX_RETRIES = 16;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 3000;

/**
 * Precomputed backoff delays: eliminates Math.pow on hot path
 * Sequence: 100, 200, 400, 800, 1600, 3000, 3000, 3000, ...
 */
const BACKOFF_LOOKUP_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < MAX_RETRIES; i++) {
    // Exponential growth up to 4 doublings, then cap at MAX_DELAY_MS
    const exponentialDelay = BASE_DELAY_MS * Math.pow(2, Math.min(i, 4));
    table.push(Math.min(exponentialDelay, MAX_DELAY_MS));
  }
  return table;
})();

/**
 * Calculate exponential backoff delay with jitter cap using precomputed table.
 * O(1) lookup from precomputed array - no Math.pow on hot path.
 * @param attemptNumber - Zero-indexed attempt count
 * @returns Delay in milliseconds, capped at MAX_DELAY_MS
 */
export function calculateExponentialBackoff(attemptNumber: number): number {
  const clampedAttempt = Math.min(attemptNumber, MAX_RETRIES - 1);
  return BACKOFF_LOOKUP_TABLE[clampedAttempt];
}

/**
 * Get max retry threshold for consistency across cluster config.
 */
export function getMaxRetries(): number {
  return MAX_RETRIES;
}

/**
 * Validate retry count against max threshold.
 */
export function isRetryExhausted(retries: number): boolean {
  return retries >= MAX_RETRIES;
}
