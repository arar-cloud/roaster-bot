import { Request, Response, NextFunction } from 'express';

interface ErrorWithStatus extends Error {
  status?: number;
  statusCode?: number;
}

/**
 * Sanitize error messages to prevent information disclosure
 * Only expose safe error messages to clients
 */
const getSafeErrorMessage = (error: ErrorWithStatus, isDevelopment: boolean): string => {
  // List of safe error messages that can be shown to clients
  const safeMessages: Record<string, string> = {
    'WEBHOOK_SECRET': 'Invalid webhook signature',
    'Content-Type': 'Invalid Content-Type header',
    'Payload too large': 'Request payload too large',
    'Authentication required': 'Authentication required',
    'Invalid API key': 'Invalid API key',
    'CORS not allowed': 'Origin not allowed',
    'Invalid action field': 'Invalid request format',
    'Payload must be an object': 'Invalid request payload',
    'Too many user messages': 'Too many messages in request',
    'Too many commits': 'Too many commits in request',
  };

  // Check if error message contains any safe keywords
  for (const [key, safeMsg] of Object.entries(safeMessages)) {
    if (error.message && error.message.includes(key)) {
      return safeMsg;
    }
  }

  // Default to generic message in production
  if (!isDevelopment) {
    return 'An error occurred processing your request';
  }

  // In development, show more detail
  return error.message || 'Internal server error';
};

/**
 * Global error handler middleware
 * Catches all errors and returns sanitized JSON responses
 */
export const errorHandler = (isDevelopment: boolean = false) => {
  return (err: ErrorWithStatus, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const isClientError = status >= 400 && status < 500;
    const isFatal = status >= 500;

    // Log errors with appropriate level
    if (isFatal) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: 'Unhandled error',
        status,
        path: req.path,
        method: req.method,
        errorMessage: err.message,
        // Only include stack in development
        ...(isDevelopment && { stack: err.stack }),
      }));
    } else if (isClientError) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        message: 'Client error',
        status,
        path: req.path,
        method: req.method,
        errorMessage: err.message,
      }));
    }

    // Send sanitized response
    const response: any = {
      error: getSafeErrorMessage(err, isDevelopment),
      status,
    };

    // Only include request ID if available
    if ((req as any).id) {
      response.requestId = (req as any).id;
    }

    res.status(status).json(response);
  };
};

/**
 * 404 handler for undefined routes
 */
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    error: 'Endpoint not found',
    status: 404,
    path: req.path,
  });
};
