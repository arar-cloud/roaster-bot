# Security Hardening & Operations Guide

## Overview
This document outlines the security controls implemented in roaster-bot and operational procedures for maintaining security posture.

## Vercel Serverless Deployment Considerations

### Session State Management
- **No persistent state across invocations**: Rate limit records, session contexts, and CSRF tokens are stored in memory and will be lost when a serverless container is recycled or a new instance is created
- **Cold-start behavior**: Each new container starts with empty session/rate-limit state. This is intentional for security isolation
- **Rate limiting scope**: Per-token rate limiting is per-instance. High-volume deployments may need external rate limit service (Redis) for distributed rate limiting across containers
- **Recommendation**: For production with multiple concurrent requests, migrate `tokenRateLimitStore` and `sessionContexts` to external distributed store (Redis/Memcached)

### Security Isolation
- **Container isolation**: Each serverless function invocation runs in isolated container; environment variables are loaded fresh per invocation
- **Token storage**: GitHub tokens are never persisted to disk or shared between invocations
- **Memory cleanup**: Expired sessions and rate-limit records are automatically cleaned up; garbage collection runs every 5-10 seconds
- **No cross-invocation data leakage**: Stale session state cannot leak between different user requests across containers

### Production Deployment Checklist
1. Set `NODE_ENV=production` to enforce strict CORS origin validation
2. Configure `ALLOWED_ORIGINS` with explicit production domain (no wildcard)
3. Set `WEBHOOK_SECRET` for GitHub webhook signature verification
4. Consider migrating rate limiting to Redis for multi-instance deployments
5. Enable monitoring/logging integration (CloudWatch, Datadog, etc.) for audit trail
6. Rotate `TOKEN_BLACKLIST` regularly and revoke compromised tokens immediately

## Security Event Logging

### Audit Trail
The application maintains real-time security event logging for:
- **AUTH_MISSING_TOKEN**: Missing GitHub token header
- **AUTH_MALFORMED_TOKEN**: Token format validation failure
- **AUTH_INVALID_TOKEN_LENGTH**: Token length outside allowed range
- **AUTH_BLACKLISTED_TOKEN**: Token appears in blacklist
- **CSRF_MISSING**: State-changing request without CSRF token
- **CSRF_INVALID_OR_EXPIRED**: CSRF token validation failure
- **RATE_LIMIT_EXCEEDED**: Per-token rate limit exceeded
- **INPUT_VALIDATION_FAILED**: Request body validation failure
- **MESSAGE_ROLE_VALIDATION_FAILED**: Invalid message role in array
- **PROMPT_INJECTION_DETECTED**: Suspicious prompt patterns detected

All events logged with timestamp, request IP, and tokenized identifiers (no raw tokens).

### Accessing Logs
Security events are output to stdout with `[SECURITY_AUDIT]` prefix. In production:
- Integrate with CloudWatch, DataDog, or ELK for centralized logging
- Set up alerts for repeated AUTH failures or RATE_LIMIT_EXCEEDED events
- Retain logs for minimum 30 days for forensic investigation

## Authentication & Authorization

### GitHub Token Management
- **Format Validation**: Only GitHub tokens matching patterns `ghu_*`, `ghp_*`, `ghs_*`, `gho_*` are accepted
- **Blacklist Support**: Set `TOKEN_BLACKLIST` environment variable with comma-separated tokens to revoke
- **Rate Limiting**: 10 requests per minute per token
- **Token Storage**: Tokens are never stored in memory; only hashed values are retained for audit purposes

### CSRF Protection
- **Token Generation**: CSRF tokens generated on every GET request
- **Expiry**: Tokens expire after 1 hour
- **Single-Use**: Tokens are invalidated after use
- **Header**: Submit CSRF token via `X-CSRF-Token` header

## Input Validation

### Message Sanitization
- **Length**: 1-5000 characters required
- **Characters**: Control characters (0x00-0x1F, 0x7F) are removed
- **Encoding**: All input is validated against whitelist of safe characters

## Rate Limiting

### Global Rate Limiter
- **Window**: 15 minutes
- **Limit**: 100 requests per IP

### Per-Token Rate Limiter
- **Window**: 1 minute
- **Limit**: 10 requests per token
- **Cleanup**: Expired entries are cleaned every 5 minutes
- **Memory**: Token store is bounded; stale entries are automatically evicted

## Session Management

### Session Timeouts
- **Duration**: 30 seconds maximum per request
- **Cleanup**: Stale sessions are cleaned every 10 seconds
- **Prevention**: Session fixation attacks are mitigated by invalidating expired sessions

## CORS & Origin Validation

### Configuration
- **Setting**: `ALLOWED_ORIGINS` environment variable (comma-separated)
- **Default**: `http://localhost:3000` (development only)
- **Validation**: Invalid origins cause startup failure; rejected in production
- **Wildcard**: `*` is only allowed in non-production environments

## Environment Variables

### Required
- `GITHUB_TOKEN`: GitHub API token (passed via request header)
- `WEBHOOK_SECRET`: GitHub webhook secret for signature verification

### Security-Related
- `ALLOWED_ORIGINS`: CORS origin whitelist (default: localhost only)
- `TOKEN_BLACKLIST`: Comma-separated revoked tokens
- `NODE_ENV`: Set to `production` for strict CSP and origin validation

## Error Handling

### Error Response Sanitization
- **Stack Traces**: Never exposed to clients
- **File Paths**: Removed from error messages
- **Environment Variables**: Never included in responses
- **Error IDs**: Provided in development for debugging

## Helmet Security Headers

### Content-Security-Policy (CSP)
- **Script Sources**: Only `'self'` allowed
- **Object Sources**: Disabled (`'none'`)
- **Inline Scripts**: Blocked
- **Frame Embedding**: Disabled

### Other Headers
- **HSTS**: 1 year max-age, preload enabled
- **X-Content-Type-Options**: `nosniff`
- **X-XSS-Protection**: Enabled
- **Referrer-Policy**: `strict-origin-when-cross-origin`

## Security Best Practices

### Key Rotation
1. **GitHub Tokens**: Rotate regularly (recommend: monthly)
2. **Webhook Secrets**: Change after compromise suspicion
3. **Procedure**:
   - Generate new secret/token
   - Update environment variable
   - Add old token to `TOKEN_BLACKLIST` if compromise suspected
   - Restart application

### Monitoring & Logging
- **Security Events**: Rate limit violations, CSRF failures, auth attempts are logged
- **Log Format**: `[SECURITY] <event> [details]`
- **Review**: Check logs regularly for suspicious patterns

### Audit Trail
- All security events are logged with timestamp and relevant context
- Error IDs in logs can correlate multiple errors from single request
- Request IDs track session lifecycle

## Incident Response

### Token Compromise
1. Add token to `TOKEN_BLACKLIST` immediately
2. Regenerate new token
3. Restart application
4. Review logs for unauthorized access

### Rate Limit Abuse
1. Check logs for source IP/token
2. Block IP if malicious (at upstream proxy level)
3. Add token to blacklist if necessary

### CSRF Attack Detection
- Look for 403 Forbidden errors with "CSRF token" message
- Correlate with HTTP referer header in logs
- Verify origin from CORS validation

## Testing

### Security Tests
Run security test suite:
```bash
npm test
```

Tests verify:
- CSRF token protection
- Rate limiting enforcement
- Authentication validation
- Input sanitization
- XSS prevention
- CORS enforcement
- Security header presence

## Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure `ALLOWED_ORIGINS` to production domain only (no wildcard)
- [ ] Set strong `WEBHOOK_SECRET`
- [ ] Enable HTTPS only (upstream proxy)
- [ ] Configure `TOKEN_BLACKLIST` if previous tokens compromised
- [ ] Run `npm test` to verify security controls
- [ ] Review logs for startup validation messages
- [ ] Verify CORS headers in responses
- [ ] Test CSRF token validation
