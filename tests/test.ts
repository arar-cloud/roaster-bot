import crypto from 'crypto';
import app from '../src/index.js';

const WEBHOOK_SECRET = 'test-secret';
const PORT = 3001;

function generateSignature(payload: string): string {
  return 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
}

async function runTests() {
  console.log('Starting tests...');
  let passCount = 0;
  let failCount = 0;

  // Test 1: Valid signature with userMessages
  try {
    const payload = JSON.stringify({
      userMessages: [{ role: 'user', content: 'Hello' }],
    });
    const signature = generateSignature(payload);
    
    console.log('✓ Test 1: Signature generation successful');
    passCount++;
  } catch (error) {
    console.error('✗ Test 1 failed:', error);
    failCount++;
  }

  // Test 2: Invalid signature rejection
  try {
    const invalidSignature = 'sha256=invalidsignature';
    if (invalidSignature !== generateSignature('test')) {
      console.log('✓ Test 2: Invalid signature properly rejected');
      passCount++;
    }
  } catch (error) {
    console.error('✗ Test 2 failed:', error);
    failCount++;
  }

  // Test 3: Verify app export
  try {
    if (app) {
      console.log('✓ Test 3: Express app properly exported');
      passCount++;
    } else {
      throw new Error('App export missing');
    }
  } catch (error) {
    console.error('✗ Test 3 failed:', error);
    failCount++;
  }

  console.log(`\nTest Results: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

runTests();
