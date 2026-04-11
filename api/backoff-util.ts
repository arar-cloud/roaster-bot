/**
 * Unified exponential backoff calculation for Redis cluster reconnection.
 * Eliminates duplicate logic and ensures consistent retry thresholds.
 * Uses 16 max retries (consistent with maxRedirections) and 100ms base delay.
 */

const MAX_RETRIES = 16;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 3000;

/**
 * Calculate exponential backoff delay with jitter cap.
 * @param attemptNumber - Zero-indexed attempt count
 * @returns Delay in milliseconds, capped at MAX_DELAY_MS
 */
export function calculateExponentialBackoff(attemptNumber: number): number {
  // Exponential: 100, 200, 400, 800, 1600, 3000, 3000, ...
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, Math.min(attemptNumber, 4));
  return Math.min(exponentialDelay, MAX_DELAY_MS);
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
