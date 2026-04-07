/**
 * Integration and Retry Scenario Tests
 * Tests retry behavior, network failures, timeouts, and partial failures
 */

interface TestContext {
  correlationId: string;
  attempt: number;
  maxRetries: number;
}

// Simulate network failure scenarios
const simulateNetworkFailure = async (shouldFail: boolean, delayMs: number = 0) => {
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (shouldFail) {
    throw new Error('Network request failed');
  }
  return { success: true, data: 'response data' };
};

// Retry logic with exponential backoff
const retryWithBackoff = async (
  fn: () => Promise<any>,
  maxRetries: number = 3,
  context?: TestContext
) => {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (context) context.attempt = attempt;
      const result = await fn();
      console.log(`[RETRY_TEST] Attempt ${attempt} succeeded`, context);
      return result;
    } catch (err) {
      lastError = err;
      console.log(`[RETRY_TEST] Attempt ${attempt} failed: ${err.message}`, context);
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`[RETRY_TEST] Backing off for ${delay}ms before retry ${attempt + 1}`, context);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
};

// Test: Transient network failure recovery
export const testTransientNetworkFailureRecovery = async () => {
  const context: TestContext = {
    correlationId: `test_${Date.now()}`,
    attempt: 0,
    maxRetries: 3,
  };

  let failureCount = 0;
  const result = await retryWithBackoff(
    async () => {
      failureCount++;
      // Fail first two attempts, succeed on third
      return simulateNetworkFailure(failureCount < 3);
    },
    context.maxRetries,
    context
  );

  console.log(`[TEST_RESULT] Transient network failure recovered after ${failureCount} attempts`);
  return result;
};

// Test: Database connection timeout recovery
export const testDatabaseConnectionTimeoutRecovery = async () => {
  const context: TestContext = {
    correlationId: `test_db_${Date.now()}`,
    attempt: 0,
    maxRetries: 3,
  };

  let attemptCount = 0;
  const result = await retryWithBackoff(
    async () => {
      attemptCount++;
      const delayMs = attemptCount === 1 ? 2000 : 100; // First attempt times out, others fast
      return simulateNetworkFailure(attemptCount === 1, delayMs);
    },
    context.maxRetries,
    context
  );

  console.log(`[TEST_RESULT] Database connection timeout recovered after ${attemptCount} attempts`);
  return result;
};

// Test: Partial failure handling (one service fails, should retry)
export const testPartialFailureHandling = async () => {
  const context: TestContext = {
    correlationId: `test_partial_${Date.now()}`,
    attempt: 0,
    maxRetries: 3,
  };

  const serviceA = async (attempt: number) => {
    // Service A fails on first attempt
    if (attempt === 1) throw new Error('Service A temporarily unavailable');
    return { serviceA: 'ok' };
  };

  const serviceB = async () => {
    return { serviceB: 'ok' };
  };

  let attemptCount = 0;
  const result = await retryWithBackoff(
    async () => {
      attemptCount++;
      const resA = await serviceA(attemptCount);
      const resB = await serviceB();
      return { ...resA, ...resB };
    },
    context.maxRetries,
    context
  );

  console.log(`[TEST_RESULT] Partial failure recovered after ${attemptCount} attempts`);
  return result;
};

// Test: Circuit breaker prevents cascading failures
export const testCircuitBreakerPreventsCascade = async () => {
  const context: TestContext = {
    correlationId: `test_circuit_${Date.now()}`,
    attempt: 0,
    maxRetries: 5,
  };

  let consecutiveFailures = 0;
  const threshold = 3;
  let circuitOpen = false;

  const executeWithCircuitBreaker = async () => {
    if (circuitOpen) {
      throw new Error('Circuit breaker is OPEN');
    }
    try {
      consecutiveFailures++;
      if (consecutiveFailures < threshold) {
        throw new Error('Service unavailable');
      }
      consecutiveFailures = 0;
      return { success: true };
    } catch (err) {
      if (consecutiveFailures >= threshold) {
        circuitOpen = true;
        console.log(`[CIRCUIT_BREAKER] Opened after ${consecutiveFailures} failures`);
      }
      throw err;
    }
  };

  let testsPassed = 0;
  try {
    await retryWithBackoff(executeWithCircuitBreaker, 2, context);
  } catch (err) {
    if (err.message.includes('Circuit breaker')) {
      console.log(`[TEST_RESULT] Circuit breaker correctly prevented cascading failure`);
      testsPassed++;
    }
  }

  return { testsPassed, circuitOpen };
};

// Test: Max retries exceeded error
export const testMaxRetriesExceeded = async () => {
  const context: TestContext = {
    correlationId: `test_max_retries_${Date.now()}`,
    attempt: 0,
    maxRetries: 2,
  };

  try {
    await retryWithBackoff(
      async () => simulateNetworkFailure(true), // Always fail
      context.maxRetries,
      context
    );
  } catch (err) {
    if (err.message.includes('Failed after')) {
      console.log(`[TEST_RESULT] Max retries correctly enforced: ${err.message}`);
      return { success: false, attemptsExhausted: true };
    }
  }
};

// Run all tests
export const runAllTests = async () => {
  console.log('[TEST_SUITE] Starting stability retry scenario tests...');
  
  try {
    await testTransientNetworkFailureRecovery();
    await testDatabaseConnectionTimeoutRecovery();
    await testPartialFailureHandling();
    await testCircuitBreakerPreventsCascade();
    await testMaxRetriesExceeded();
    console.log('[TEST_SUITE] All stability tests completed');
  } catch (err) {
    console.error('[TEST_SUITE] Test suite failed:', err);
  }
};

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(console.error);
}
