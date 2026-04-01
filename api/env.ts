/**
 * Secure environment variable access
 * Prevents exposure of sensitive credentials in API responses and logs
 */

const ALLOWED_ENV_VARS = new Set([
  'NODE_ENV',
  'PORT'
]);

const SENSITIVE_KEYS = [
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'API_KEY',
  'SECRET',
  'PASSWORD',
  'PRIVATE_KEY'
];

export function getSecureEnv(key: string): string | undefined {
  // Only allow whitelisted environment variables
  if (!ALLOWED_ENV_VARS.has(key)) {
    return undefined;
  }
  return process.env[key];
}

export function getSensitiveEnv(key: string): string | undefined {
  // For sensitive values, log access for audit trail
  const isSensitive = SENSITIVE_KEYS.some(k => key.includes(k));
  if (isSensitive) {
    console.debug(`[SECURITY] Accessing sensitive env: ${key}`);
  }
  return process.env[key];
}

export function validateAuthEnv(): boolean {
  const requiredKeys = ['OPENAI_API_KEY', 'GITHUB_TOKEN'];
  for (const key of requiredKeys) {
    if (!process.env[key]) {
      console.error(`[SECURITY] Missing required environment variable: ${key}`);
      return false;
    }
  }
  return true;
}

export function sanitizeForLogging(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.some(k => key.toUpperCase().includes(k))) {
      sanitized[key] = '***REDACTED***';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
