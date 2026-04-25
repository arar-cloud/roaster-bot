/**
 * Environment variable validation schema
 * Ensures all required secrets and config are properly set and have minimum entropy
 */

interface EnvConfig {
  WEBHOOK_SECRET: string;
  ADMIN_API_KEY?: string;
  GITHUB_TOKEN?: string;
  NODE_ENV: string;
  PORT: number;
}

const validateSecretEntropy = (secret: string, minLength: number = 32): boolean => {
  if (!secret || secret.length < minLength) return false;
  // Check for sufficient character diversity (at least 3 of 4 character classes)
  const hasLower = /[a-z]/.test(secret);
  const hasUpper = /[A-Z]/.test(secret);
  const hasDigit = /[0-9]/.test(secret);
  const hasSpecial = /[!@#$%^&*_+=\-]/.test(secret);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  return classes >= 3;
};

const validateToken = (token: string): boolean => {
  if (!token) return true; // Optional tokens are allowed to be undefined
  // GitHub tokens start with ghp_ or ghu_ and are base62
  if (token.startsWith('ghp_') || token.startsWith('ghu_')) {
    return token.length >= 36 && /^[a-zA-Z0-9_]+$/.test(token);
  }
  return false;
};

export const validateEnv = (): EnvConfig => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const adminApiKey = process.env.ADMIN_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const nodeEnv = process.env.NODE_ENV || 'development';
  const port = parseInt(process.env.PORT || '3000', 10);

  const errors: string[] = [];

  // Validate WEBHOOK_SECRET is present and has sufficient entropy
  if (!webhookSecret) {
    errors.push('WEBHOOK_SECRET is required');
  } else if (!validateSecretEntropy(webhookSecret, 32)) {
    errors.push('WEBHOOK_SECRET must be at least 32 characters with sufficient entropy');
  }

  // Validate ADMIN_API_KEY if present
  if (adminApiKey && !validateSecretEntropy(adminApiKey, 32)) {
    errors.push('ADMIN_API_KEY must be at least 32 characters with sufficient entropy if set');
  }

  // Validate GITHUB_TOKEN format if present
  if (githubToken && !validateToken(githubToken)) {
    errors.push('GITHUB_TOKEN must be a valid GitHub personal access token');
  }

  // Validate PORT is a valid number in acceptable range
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push('PORT must be a valid number between 1 and 65535');
  }

  if (errors.length > 0) {
    console.error('Environment validation failed:');
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  return {
    WEBHOOK_SECRET: webhookSecret,
    ADMIN_API_KEY: adminApiKey,
    GITHUB_TOKEN: githubToken,
    NODE_ENV: nodeEnv,
    PORT: port,
  };
};
