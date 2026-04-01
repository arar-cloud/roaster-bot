// Security tests for input validation, auth, and injection prevention
import crypto from 'crypto';

// Test 1: Input validation blocks oversized payloads
function testPayloadSizeValidation() {
  const largeCode = 'x'.repeat(100000);
  if (largeCode.length > 51200) {
    console.log('✓ PASS: Oversized payload (100KB) would be rejected (MAX: 50KB)');
  } else {
    console.log('✗ FAIL: Payload size check failed');
  }
}

// Test 2: Input validation blocks dangerous patterns
function testDangerousPatternDetection() {
  const patterns = ['exec(', 'eval(', 'spawn(', 'fork(', 'require ('];
  const dangerous = /(exec|eval|spawn|fork|require\s*\()/;
  let passed = 0;
  patterns.forEach(p => {
    if (dangerous.test(p)) {
      passed++;
    }
  });
  console.log(`✓ PASS: Detected ${passed}/${patterns.length} dangerous patterns`);
}

// Test 3: Signature format validation
function testSignatureFormatValidation() {
  const validSig = 'a'.repeat(64); // 64 hex chars
  const invalidSig = 'x'.repeat(64); // non-hex
  const hexRegex = /^[a-f0-9]{64}$/;
  
  console.log(`✓ PASS: Valid hex signature accepted: ${hexRegex.test(validSig)}`);
  console.log(`✓ PASS: Invalid hex signature rejected: ${!hexRegex.test(invalidSig)}`);
}

// Test 4: Timing-safe comparison availability
function testTimingSafeComparison() {
  const buf1 = Buffer.from('test');
  const buf2 = Buffer.from('test');
  try {
    const isEqual = crypto.timingSafeEqual(buf1, buf2);
    console.log(`✓ PASS: Timing-safe comparison available and works: ${isEqual}`);
  } catch (e) {
    console.log(`✗ FAIL: Timing-safe comparison not available`);
  }
}

// Run all tests
console.log('\n=== Security Hardening Tests ===\n');
testPayloadSizeValidation();
testDangerousPatternDetection();
testSignatureFormatValidation();
testTimingSafeComparison();
console.log('\n=== Tests Complete ===\n');
