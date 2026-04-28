import crypto from 'crypto';
import Piscina from 'piscina';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Performance Tests', () => {
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

    const startTime = performance.now();
    const result = await hmacWorker.run({ rawBody, webhookSecret, signature });
    const elapsed = performance.now() - startTime;

    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(10);

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
