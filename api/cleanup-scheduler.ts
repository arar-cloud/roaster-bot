/**
 * Chunked cleanup scheduler for expired token bucket entries.
 * Processes Map entries incrementally across event loop iterations
 * to prevent blocking on 10k+ entry maps every 5 seconds.
 * Supports explicit cancellation to prevent resource leaks.
 */

const CHUNK_SIZE = 100; // Process 100 entries per setImmediate tick

interface CleanupStats {
  totalScanned: number;
  totalEvicted: number;
  completedAt: number;
}

interface CleanupTask<K, V> {
  intervalHandle: NodeJS.Timeout | null;
  immediateHandle: NodeJS.Immediate | null;
}

const activeTasks: Map<string, CleanupTask<any, any>> = new Map();

/**
 * Schedule chunked cleanup of expired entries from a Map.
 * @param expiredMap - Map with entry expiration times
 * @param isExpiredFn - Function to determine if entry is expired
 * @param onComplete - Callback with cleanup statistics
 * @param taskId - Unique task identifier for cancellation
 * @returns taskId for later cancellation
 */
export function scheduleChunkedCleanup<K, V>(
  expiredMap: Map<K, V>,
  isExpiredFn: (value: V) => boolean,
  onComplete?: (stats: CleanupStats) => void,
  taskId: string = `cleanup_${Date.now()}_${Math.random()}`
): string {
  const task: CleanupTask<K, V> = {
    intervalHandle: null,
    immediateHandle: null,
  };
  activeTasks.set(taskId, task);

  const entries = Array.from(expiredMap.entries());
  let index = 0;
  let evicted = 0;
  const totalEntries = entries.length;
  const startTime = Date.now();

  const processChunk = (): void => {
    // Check if task was cancelled
    if (!activeTasks.has(taskId)) {
      return;
    }

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
      task.immediateHandle = setImmediate(processChunk);
    } else {
      // Cleanup complete
      const stats: CleanupStats = {
        totalScanned: totalEntries,
        totalEvicted: evicted,
        completedAt: Date.now() - startTime,
      };
      activeTasks.delete(taskId);
      onComplete?.(stats);
    }
  };

  // Start first chunk
  task.immediateHandle = setImmediate(processChunk);
  return taskId;
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

/**
 * Cancel scheduled chunked cleanup by task ID.
 * Clears any pending setImmediate handles to prevent orphaned timers.
 */
export function cancelChunkedCleanup(taskId: string): void {
  const task = activeTasks.get(taskId);
  if (task) {
    if (task.immediateHandle) {
      clearImmediate(task.immediateHandle);
    }
    if (task.intervalHandle) {
      clearInterval(task.intervalHandle);
    }
    activeTasks.delete(taskId);
  }
}
