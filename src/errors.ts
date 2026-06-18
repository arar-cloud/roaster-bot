// Structured error handling and logging utilities

export interface ErrorContext {
  requestId?: string;
  path?: string;
  method?: string;
  timestamp: number;
  correlationId?: string;
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public context?: ErrorContext
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: ErrorContext) {
    super(400, message, context);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string, context?: ErrorContext) {
    super(401, message, context);
    this.name = 'AuthenticationError';
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    message: string,
    public retryable: boolean = true,
    context?: ErrorContext
  ) {
    super(503, message, context);
    this.name = 'ExternalServiceError';
  }
}

export function logError(
  error: Error | AppError,
  context?: ErrorContext
): void {
  const timestamp = new Date().toISOString();
  const errorContext = {
    timestamp,
    ...(context || {}),
  };

  if (error instanceof AppError) {
    console.error(JSON.stringify({
      level: 'error',
      error: error.name,
      message: error.message,
      statusCode: error.statusCode,
      ...errorContext,
    }));
  } else {
    console.error(JSON.stringify({
      level: 'error',
      error: error.name || 'UnknownError',
      message: error.message,
      stack: error.stack,
      ...errorContext,
    }));
  }
}

export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
  timeoutMs: number;
}

export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 3,
  delayMs: 500,
  backoffMultiplier: 2,
  timeoutMs: 5000,
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = defaultRetryConfig,
  context?: ErrorContext
): Promise<T> {
  let lastError: Error | null = null;
  let delay = config.delayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new Error('Operation timeout')),
            config.timeoutMs
          )
        ),
      ]);
    } catch (error) {
      lastError = error as Error;
      if (attempt < config.maxAttempts) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            message: 'Retry attempt',
            attempt,
            nextRetryIn: delay,
            error: lastError.message,
            ...context,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= config.backoffMultiplier;
      }
    }
  }

  if (lastError) {
    throw new ExternalServiceError(
      `Operation failed after ${config.maxAttempts} attempts: ${lastError.message}`,
      true,
      context
    );
  }

  throw new Error('Retry exhausted');
}
