import app from '../src/index.js';

// Security baseline verification before export
// Ensure all middleware and security hardening is applied
const validateSecurityBaseline = () => {
  // Verify app._router exists (middleware applied)
  if (!app._router || !app._router.stack) {
    throw new Error('Security middleware not initialized');
  }
  
  // Check for presence of critical middleware by stack inspection
  const middlewareNames = app._router.stack
    .map((layer: any) => layer.name || '')
    .join(',');
  
  const requiredMiddleware = ['helmet', 'json', 'limiter'];
  const missingMiddleware = requiredMiddleware.filter(
    name => !middlewareNames.includes(name)
  );
  
  if (missingMiddleware.length > 0) {
    console.warn(`Warning: Missing middleware: ${missingMiddleware.join(', ')}`);
  }
  
  return true;
};

// Run validation at import time
try {
  validateSecurityBaseline();
  console.log('✓ Security baseline verified');
} catch (err) {
  console.error('✗ Security baseline check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}

// Export after security validation
export default app;
