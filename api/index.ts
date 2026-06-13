import app from '../src/index.js';

// Recursive function to sanitize error objects and remove sensitive data
const sanitizeError = (err: any, depth: number = 0): any => {
  if (depth > 5) return {}; // Prevent infinite recursion
  
  const sensitivePatterns = ['password', 'token', 'secret', 'api_key', 'key', 'authorization', 'stackTrace', 'stack', 'sql', 'query'];
  const isSensitive = (key: string): boolean => sensitivePatterns.some(p => key.toLowerCase().includes(p));
  
  if (err === null || err === undefined) return null;
  if (typeof err === 'string') return err.substring(0, 200); // Limit string length
  if (typeof err === 'number' || typeof err === 'boolean') return err;
  
  if (Array.isArray(err)) {
    return err.slice(0, 10).map((item: any) => sanitizeError(item, depth + 1));
  }
  
  if (typeof err === 'object') {
    const sanitized: any = {};
    Object.keys(err).forEach(key => {
      if (!isSensitive(key)) {
        sanitized[key] = sanitizeError(err[key], depth + 1);
      }
    });
    return sanitized;
  }
  
  return null;
};

// Global error handler to catch unhandled errors
app.use((err: any, req: any, res: any, next: any) => {
  const errorMessage = err instanceof Error ? err.message : 'Unknown error';
  const errorType = err?.name || 'Error';
  const sanitizedDetails = sanitizeError(err);
  console.error(`[UNHANDLED_ERROR] type=${errorType}, message=${errorMessage}, sanitized_details=${JSON.stringify(sanitizedDetails)}, timestamp=${new Date().toISOString()}`);
  // Do not expose stack trace, internal details, or sensitive data in error response
  res.status(500).json({ error: 'Internal server error' });
});

export default app;