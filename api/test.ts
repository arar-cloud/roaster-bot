import crypto from 'crypto';

// Mock test suite to validate request handlers and signature validation
const runTests = async () => {
  console.log('Starting test suite...');
  
  let passed = 0;
  let failed = 0;

  // Test 1: GET / should return HTML without rebuild overhead
  console.log('Test 1: GET / returns static HTML');
  try {
    const response = await fetch('http://localhost:3000/', { method: 'GET' });
    if (response.status === 200) {
      const text = await response.text();
      if (text.includes('The Roaster is Online')) {
        console.log('  ✓ PASS: GET / returns expected HTML');
        passed++;
      } else {
        console.log('  ✗ FAIL: GET / returned unexpected content');
        failed++;
      }
    } else {
      console.log('  ✗ FAIL: GET / returned status ' + response.status);
      failed++;
    }
  } catch (err) {
    console.log('  ✗ FAIL: GET / threw error: ' + err);
    failed++;
  }

  // Test 2: POST /agent without signature should be rejected
  console.log('Test 2: POST /agent rejects missing signature');
  try {
    const response = await fetch('http://localhost:3000/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'data' })
    });
    if (response.status === 400) {
      console.log('  ✓ PASS: POST /agent rejects missing signature');
      passed++;
    } else {
      console.log('  ✗ FAIL: Expected 400, got ' + response.status);
      failed++;
    }
  } catch (err) {
    console.log('  ✗ FAIL: Error: ' + err);
    failed++;
  }

  // Test 3: POST /agent with invalid signature should be rejected
  console.log('Test 3: POST /agent rejects invalid signature');
  try {
    const response = await fetch('http://localhost:3000/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-hook-secret': 'invalid-signature-here'
      },
      body: JSON.stringify({ test: 'data' })
    });
    if (response.status === 401) {
      console.log('  ✓ PASS: POST /agent rejects invalid signature');
      passed++;
    } else {
      console.log('  ✗ FAIL: Expected 401, got ' + response.status);
      failed++;
    }
  } catch (err) {
    console.log('  ✗ FAIL: Error: ' + err);
    failed++;
  }

  // Test 4: POST /agent with valid signature should proceed (or hit rate limit)
  console.log('Test 4: POST /agent with valid signature passes verification');
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET || 'test-secret';
    const payload = JSON.stringify({ test: 'data' });
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    const response = await fetch('http://localhost:3000/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-hook-secret': signature
      },
      body: payload
    });
    // Accept 200, 429 (rate limit), or 500 (client error) as passing signature validation
    if (response.status !== 401 && response.status !== 400) {
      console.log('  ✓ PASS: POST /agent accepted valid signature (status: ' + response.status + ')');
      passed++;
    } else {
      console.log('  ✗ FAIL: Valid signature rejected with status ' + response.status);
      failed++;
    }
  } catch (err) {
    console.log('  ✗ FAIL: Error: ' + err);
    failed++;
  }

  console.log(`\nTest Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
};

// Run tests if this file is executed
if (import.meta.url === `file://${process.argv[1]}`) {
  setTimeout(runTests, 1000); // Wait for server to start
}

export { runTests };
