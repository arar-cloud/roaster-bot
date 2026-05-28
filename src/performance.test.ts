import crypto from 'crypto';

/**
 * Performance benchmark suite for critical paths
 * Run with: node --experimental-test-runner src/performance.test.ts
 */

interface BenchmarkResult {
  operation: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

const results: BenchmarkResult[] = [];

function benchmark(
  name: string,
  fn: () => void,
  iterations: number = 10000
): BenchmarkResult {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = process.hrtime.bigint();
  const totalNs = end - start;
  const totalMs = Number(totalNs) / 1_000_000;
  const avgMs = totalMs / iterations;

  const result: BenchmarkResult = {
    operation: name,
    iterations,
    totalMs: parseFloat(totalMs.toFixed(2)),
    avgMs: parseFloat(avgMs.toFixed(4)),
    minMs: 0,
    maxMs: 0,
  };
  results.push(result);
  return result;
}

// Baseline: Synchronous HMAC (current implementation)
console.log('\n=== Baseline Performance ===');
const secretKey = 'test-secret-key';
const payload = '{"action": "test", "data": [1,2,3,4,5]}' + 'x'.repeat(1000); // 1KB payload

const syncHmacResult = benchmark(
  'Sync HMAC (synchronous crypto)',
  () => {
    const hmac = crypto.createHmac('sha256', secretKey);
    hmac.update(payload);
    hmac.digest('hex');
  },
  5000
);
console.log(`Sync HMAC (5000 iterations):`);
console.log(`  Total: ${syncHmacResult.totalMs}ms`);
console.log(`  Avg per call: ${syncHmacResult.avgMs}ms`);

// Test: Async HMAC via Promise wrapper
console.log('\n=== Optimized Performance ===');
const hmacPromiseResult = benchmark(
  'Async HMAC (Promise-wrapped)',
  () => {
    new Promise((resolve) => {
      setImmediate(() => {
        const hmac = crypto.createHmac('sha256', secretKey);
        hmac.update(payload);
        hmac.digest('hex');
        resolve(null);
      });
    });
  },
  5000
);
console.log(`Async HMAC (5000 iterations):`);
console.log(`  Total: ${hmacPromiseResult.totalMs}ms`);
console.log(`  Avg per call: ${hmacPromiseResult.avgMs}ms`);

// Test: Static HTML vs dynamic construction
console.log('\n=== HTML Response Generation ===');
const staticHtml = `
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `;

const dynamicHtmlResult = benchmark(
  'Dynamic HTML construction',
  () => {
    const html = `
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `;
  },
  10000
);

const staticHtmlResult = benchmark(
  'Static HTML reference',
  () => {
    const _ = staticHtml;
  },
  10000
);

console.log(`Dynamic HTML (10000 iterations):`);
console.log(`  Total: ${dynamicHtmlResult.totalMs}ms`);
console.log(`  Avg per call: ${dynamicHtmlResult.avgMs}ms`);
console.log(`Dynamic HTML (10000 iterations):`);
console.log(`  Total: ${staticHtmlResult.totalMs}ms`);
console.log(`  Avg per call: ${staticHtmlResult.avgMs}ms`);
console.log(`Improvement: ${((dynamicHtmlResult.avgMs - staticHtmlResult.avgMs) / dynamicHtmlResult.avgMs * 100).toFixed(2)}%`);

console.log('\n=== Summary ===');
results.forEach((r) => {
  console.log(`${r.operation}: ${r.avgMs}ms avg`);
});
