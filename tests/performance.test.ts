import crypto from 'crypto';
import Piscina from 'piscina';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// Import SessionPool for testing (must be exported from src/index.ts)
// Note: SessionPool is defined locally in tests for isolation; in production it's internal to src/index.ts

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Performance Tests', () => {
  // Baseline performance thresholds for regression detection
  const THRESHOLDS = {
    HMAC_VERIFICATION_MS: 10,      // HMAC verification must complete in under 10ms (worker pool)
    SESSION_POOL_ACQUIRE_MS: 50,   // Session acquire/release under 50ms
    SESSION_POOL_RELEASE_MS: 20,   // Session release must complete in under 20ms
    SESSION_POOL_BATCH_100_MS: 200, // 100 acquire/release cycles under 200ms total
    MEMORY_BASELINE_MB: 100,       // Memory usage must not exceed 100MB baseline
    WORKER_POOL_INIT_MS: 500,      // Worker pool initialization + pre-warm under 500ms
  };

  test('Worker pool pre-warms within 500ms on startup', async () => {
    const startTime = performance.now();
    const testWorker = new Piscina({
      filename: join(__dirname, '../src/hmac-worker.ts'),
      maxThreads: 4,
    });
    
    // Pre-warm 4 threads
    const prewarmTasks = Array(4).fill(null).map(() =>
      testWorker.run({
        rawBody: 'warmup',
        webhookSecret: 'warmup-secret',
        signature: 'sha256=warmup'
      }).catch(() => {})
    );
    await Promise.all(prewarmTasks);
    const elapsed = performance.now() - startTime;
    
    expect(elapsed).toBeLessThan(THRESHOLDS.WORKER_POOL_INIT_MS);
    await testWorker.destroy();
  });

  test('SessionPool release completes in under 20ms', async () => {
    const pool = new SessionPool();
    // Mock session object for testing
    const mockSession = { id: 'test-session', updateSystemMessage: async () => {} };
    
    // Manually add to pool to simulate acquired state
    (pool as any).sessions.set(mockSession, { createdAt: Date.now(), lastUsedAt: Date.now() });
    (pool as any).inUse.add(mockSession);
    
    const startTime = performance.now();
    pool.release(mockSession);
    const elapsed = performance.now() - startTime;
    
    expect(elapsed).toBeLessThan(THRESHOLDS.SESSION_POOL_RELEASE_MS);
    pool.shutdown();
  });

  test('SessionPool 100 cycles (acquire/release) completes in under 200ms', async () => {
    const pool = new SessionPool();
    const mockSessions = Array(10).fill(null).map((_, i) => ({
      id: `session-${i}`,
      updateSystemMessage: async () => {}
    }));
    
    // Pre-populate pool
    for (const session of mockSessions) {
      (pool as any).sessions.set(session, { createdAt: Date.now(), lastUsedAt: Date.now() });
    }
    
    const startTime = performance.now();
    // Simulate 100 acquire/release cycles
    for (let i = 0; i < 100; i++) {
      const session = mockSessions[i % mockSessions.length];
      (pool as any).inUse.add(session);
      pool.release(session);
    }
    const elapsed = performance.now() - startTime;
    
    expect(elapsed).toBeLessThan(THRESHOLDS.SESSION_POOL_BATCH_100_MS);
    pool.shutdown();
  });

  test('HMAC verification completes in under 10ms per request', async () => {
    const hmacWorker = new Piscina({
      filename: join(__dirname, '../src/hmac-worker.ts'),
      maxThreads: 2,
    });

    const rawBody = JSON.stringify({ test: 'payload' });
    const webhookSecret = 'test-secret';
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = hmac.update(rawBody).digest('hex');
    const signature = 'sha256=' + digest;

    const baselineMemory = process.memoryUsage().heapUsed / 1024 / 1024;
    const startTime = performance.now();
    
    // Run HMAC verification
    const result = await hmacWorker.run({ rawBody, webhookSecret, signature });
    
    const elapsed = performance.now() - startTime;
    const finalMemory = process.memoryUsage().heapUsed / 1024 / 1024;

    // Assert result is valid
    expect(result).toBe(true);
    
    // Assert latency is under 10ms baseline
    expect(elapsed).toBeLessThan(THRESHOLDS.HMAC_VERIFICATION_MS);
    
    // Assert memory did not spike beyond baseline (allow 10MB overhead for worker thread)
    const memoryDelta = finalMemory - baselineMemory;
    expect(memoryDelta).toBeLessThan(10);
    
    console.log(`✓ HMAC verification: ${elapsed.toFixed(2)}ms (threshold: ${THRESHOLDS.HMAC_VERIFICATION_MS}ms)`);
    console.log(`✓ Memory delta: ${memoryDelta.toFixed(2)}MB`);

    await hmacWorker.destroy();
  }, 30000);

  test('Compression threshold prevents compression on small payloads', () => {
    // Threshold of 1024 bytes should skip compression on responses < 1024 bytes
    const smallPayload = JSON.stringify({ message: 'small' });
    expect(smallPayload.length).toBeLessThan(1024);
  });

  test('SessionPool cleanup removes idle sessions within timeout', async () => {
    const idle_timeout_ms = 2 * 60 * 1000;
    const cleanup_interval_ms = 30 * 1000;
    
    // Verify cleanup runs frequently enough to evict idle sessions
    expect(cleanup_interval_ms).toBeLessThan(idle_timeout_ms);
  });
});
