import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

interface AuditEvent {
  timestamp: string;
  requestId: string;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  clientIp: string | undefined;
  userAgent: string | undefined;
  path: string;
  method: string;
  statusCode?: number;
  details?: Record<string, unknown>;
}

/**
 * Generate unique request ID for tracing
 */
const generateRequestId = (): string => {
  return crypto.randomBytes(8).toString('hex');
};

/**
 * Mask IP address for privacy while maintaining identifier
 */
const maskIpAddress = (ip: string | undefined): string => {
  if (!ip) return 'unknown';
  
  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.*.* `;
  }
  
  // IPv6
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, 2).join(':')}:*:*`;
  }
  
  return 'unknown';
};

/**
 * Request context middleware - adds request ID and tracking
 */
export const requestContextMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const requestId = generateRequestId();
  (req as any).id = requestId;
  (req as any).startTime = Date.now();
  
  // Capture response status
  const originalSend = res.send;
  res.send = function (data: any) {
    (req as any).statusCode = res.statusCode;
    return originalSend.call(this, data);
  };
  
  next();
};

/**
 * Log security event with full context
 */
export const logSecurityEvent = (
  req: Request,
  level: 'info' | 'warn' | 'error',
  category: string,
  message: string,
  details?: Record<string, unknown>
): void => {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    requestId: (req as any).id || 'unknown',
    level,
    category,
    message,
    clientIp: maskIpAddress(req.ip),
    userAgent: req.get('User-Agent'),
    path: req.path,
    method: req.method,
    statusCode: (req as any).statusCode,
    details,
  };
  
  console.log(JSON.stringify(event));
  
  // Store in memory for audit log (in production, send to centralized logging)
  if ((global as any).auditLog === undefined) {
    (global as any).auditLog = [];
  }
  (global as any).auditLog.push(event);
  
  // Prevent memory leak - keep only last 1000 events
  if ((global as any).auditLog.length > 1000) {
    (global as any).auditLog = (global as any).auditLog.slice(-1000);
  }
};

/**
 * Log failed authentication attempt
 */
export const logAuthFailure = (
  req: Request,
  reason: string,
  details?: Record<string, unknown>
): void => {
  logSecurityEvent(req, 'warn', 'AUTH_FAILURE', reason, {
    ...details,
    headers: {
      contentType: req.get('Content-Type'),
      hasApiKey: !!req.get('X-API-Key'),
      hasSignature: !!req.get('X-Hub-Signature-256'),
    },
  });
};

/**
 * Log rate limit hit
 */
export const logRateLimit = (
  req: Request,
  endpoint: string,
  limit: number
): void => {
  logSecurityEvent(req, 'warn', 'RATE_LIMIT', `Rate limit exceeded on ${endpoint}`, {
    endpoint,
    limit,
  });
};

/**
 * Log input validation failure
 */
export const logValidationFailure = (
  req: Request,
  field: string,
  reason: string,
  details?: Record<string, unknown>
): void => {
  logSecurityEvent(req, 'warn', 'VALIDATION_FAILURE', `Invalid ${field}: ${reason}`, {
    field,
    reason,
    ...details,
  });
};

/**
 * Log malicious payload detection
 */
export const logMaliciousPayload = (
  req: Request,
  detectedThreats: string[],
  details?: Record<string, unknown>
): void => {
  logSecurityEvent(req, 'error', 'MALICIOUS_PAYLOAD', 'Malicious payload detected', {
    threats: detectedThreats,
    ...details,
  });
};
