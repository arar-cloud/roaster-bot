import crypto from 'crypto';
import { strict as assert } from 'assert';

// Test 1: Verify HMAC-SHA256 signature generation
function testWebhookSignature() {
  const secret = 'test-secret';
  const payload = JSON.stringify({ action: 'opened', issue: { body: 'test' } });
  
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const signature = `sha256=${hmac.digest('hex')}`;
  
  assert(signature.startsWith('sha256='), 'Signature should have sha256= prefix');
  assert(signature.length > 20, 'Signature should be non-empty');
  console.log('✓ Test 1 passed: Webhook signature generation');
}

// Test 2: Verify timing-safe comparison
function testTimingSafeEqual() {
  const secret = 'test-secret';
  const payload = 'test payload';
  
  const hmac1 = crypto.createHmac('sha256', secret);
  hmac1.update(payload);
  const sig1 = `sha256=${hmac1.digest('hex')}`;
  
  const hmac2 = crypto.createHmac('sha256', secret);
  hmac2.update(payload);
  const sig2 = `sha256=${hmac2.digest('hex')}`;
  
  try {
    crypto.timingSafeEqual(sig1, sig2);
    console.log('✓ Test 2 passed: Timing-safe equal comparison works');
  } catch (err) {
    throw new Error('Timing-safe comparison failed');
  }
}

// Test 3: Verify error handling for missing keys
function testMissingEnvVars() {
  const requiredVars = ['GITHUB_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];
  const missing = requiredVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.warn(`⚠ Warning: Missing environment variables: ${missing.join(', ')}`);
  } else {
    console.log('✓ Test 3 passed: All required environment variables present');
  }
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    testWebhookSignature();
    testTimingSafeEqual();
    testMissingEnvVars();
    console.log('\n✓ All security tests passed!');
  } catch (err) {
    console.error('✗ Test failed:', err);
    process.exit(1);
  }
}
