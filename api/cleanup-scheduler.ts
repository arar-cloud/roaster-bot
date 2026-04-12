/**
 * Chunked cleanup scheduler for expired token bucket entries.
 * Processes Map entries incrementally across event loop iterations
 * to prevent blocking on 10k+ entry maps every 5 seconds.
 */

const CHUNK_SIZE = 100; // Process 100 entries per setImmediate tick

interface CleanupStats {
  totalScanned: number;
  totalEvicted: number;
  completedAt: number;
}

/**
 * Schedule chunked cleanup of expired entries from a Map.
 * @param expiredMap - Map with entry expiration times
 * @param isExpiredFn - Function to determine if entry is expired
 * @param onComplete - Callback with cleanup statistics
 */
export function scheduleChunkedCleanup<K, V>(
  expiredMap: Map<K, V>,
  isExpiredFn: (value: V) => boolean,
  onComplete?: (stats: CleanupStats) => void
): void {
  const entries = Array.from(expiredMap.entries());
  let index = 0;
  let evicted = 0;
  const totalEntries = entries.length;
  const startTime = Date.now();

  const processChunk = (): void => {
    const chunkEnd = Math.min(index + CHUNK_SIZE, entries.length);

    // Process one chunk
    for (let i = index; i < chunkEnd; i++) {
      const [key, value] = entries[i];
      if (isExpiredFn(value)) {
        expiredMap.delete(key);
        evicted++;
      }
    }

    index = chunkEnd;

    if (index < entries.length) {
      // More chunks to process: yield to event loop
      setImmediate(processChunk);
    } else {
      // Cleanup complete
      const stats: CleanupStats = {
        totalScanned: totalEntries,
        totalEvicted: evicted,
        completedAt: Date.now() - startTime,
      };
      onComplete?.(stats);
    }
  };

  // Start first chunk
  setImmediate(processChunk);
}

/**
 * Schedule periodic cleanup with fixed interval and concurrency control.
 * Prevents overlapping cleanup runs to avoid concurrent I/O contention.
 * Uses async/await for proper non-blocking event loop handling.
 * @param cleanupFn - Async cleanup function
 * @param intervalMs - Cleanup interval in milliseconds
 * @returns Cleanup interval ID for cancellation
 */
export function schedulePeriodicCleanup(
  cleanupFn: () => Promise<void>,
  intervalMs: number = 5000
): NodeJS.Timeout {
  let isRunning = false;

  return setInterval(async () => {
    // Skip if cleanup already running - prevents concurrent overlaps
    if (isRunning) {
      return;
    }

    isRunning = true;
    try {
      await cleanupFn();
    } catch (error) {
      console.error('Periodic cleanup error:', error);
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}

/**
 * Cancel periodic cleanup by interval ID.
 */
export function cancelPeriodicCleanup(intervalId: NodeJS.Timeout): void {
  clearInterval(intervalId);
}
