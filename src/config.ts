// Configuration and environment variable validation

interface Config {
  port: number;
  webhookSecret: string;
  githubToken: string;
  nodeEnv: string;
}

function validateEnvVars(): Config {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const githubToken = process.env.GITHUB_TOKEN;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const nodeEnv = process.env.NODE_ENV || 'development';

  const missing: string[] = [];

  if (!webhookSecret) {
    missing.push('WEBHOOK_SECRET');
  }
  if (!githubToken) {
    missing.push('GITHUB_TOKEN');
  }

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(', ')}`;
    console.error(JSON.stringify({
      level: 'error',
      message,
      timestamp: new Date().toISOString(),
    }));
    throw new Error(message);
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    const message = `Invalid PORT: ${port}`;
    console.error(JSON.stringify({
      level: 'error',
      message,
      timestamp: new Date().toISOString(),
    }));
    throw new Error(message);
  }

  return {
    port,
    webhookSecret,
    githubToken,
    nodeEnv,
  };
}

export const config = validateEnvVars();
