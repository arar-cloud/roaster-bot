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

## Security Controls Implemented

### Input Validation

#### Per-Field Size Limits
- **code field**: Maximum 50 KB
- **prompt field**: Maximum 10 KB
- **message content**: Maximum 10 KB per message
- **messages array**: Maximum 100 items
- **JSON body**: Maximum 1 MB (global)

#### Field Type Validation
- `code`: Must be string
- `prompt`: Must be string
- `language`: Must be string from whitelist (javascript, typescript, python, java, go, rust, c, cpp)
- `messages`: Must be array of objects with `role` and `content` (both strings)

#### Validation Function
All inputs validated via `validateInputFields()` before processing. Returns early with sanitized 400 error if validation fails.

### Prompt Injection Protection

#### Injection Pattern Detection
Prompts are scanned for suspicious patterns indicating injection attempts:
- `system:` prefix
- `ignore previous instructions`
- `pretend you are` / `act as if`
- `forget the rules`
- `<<SYS>>` / `[SYSTEM]` / `{system}` markers

Matching prompts are rejected with 400 error and logged as `PROMPT_INJECTION_DETECTED`.

#### Role Separation
Message `role` field strictly validated to only allow:
- `user`
- `assistant`

System role injection attempts rejected immediately.

#### Sanitization Function
`sanitizePromptInput()` function:
1. Validates prompt is non-empty string
2. Scans for injection patterns
3. Cross-checks prompt doesn't contain user's code (suspicious)
4. Truncates to 10 KB maximum
5. Returns safe flag and sanitized content

### Error Handling & Information Leakage Prevention

#### Sensitive Pattern Filtering
Error messages are scanned for patterns that leak sensitive information:
- API key references
- Token references
- Password references
- Secret references
- Database connection strings
- File paths
- Process/environment references

Matching errors are replaced with generic "Internal server error" message.

#### Error Message Length Limit
Error messages truncated to 200 characters maximum to prevent side-channel information leakage.

#### Internal Logging
Full error details (including stack traces) logged server-side only via console.error. Client never receives internal error details.

### Session Management & Cleanup

#### Session Storage
- Each request gets unique `requestId` (UUID)
- Session stores: token hash (SHA256, first 16 chars), start time, request ID
- Raw tokens never stored
- Session contexts isolated per request

#### Active Cleanup
- Sessions expire after 30 seconds inactivity
- `cleanupExpiredSessions()` runs every 10 seconds
- Expired sessions forcefully deleted (not lazy-deleted)
- Session deleted immediately after request completes

#### Memory Isolation
- No session state persists between requests
- No token reuse possible (stored hashed only)
- Vercel serverless isolation enforced via container boundaries

### Rate Limiting

#### Global Rate Limit
- **GET /** endpoint: 100 requests per 15 minutes per IP
- Implemented via `express-rate-limit` middleware

#### Per-Token Rate Limit
- **POST /agent**: 10 requests per minute per token
- Sliding window counter implementation
- Token hash used (not raw token)
- Store auto-cleanup removes expired entries
- Maximum store size: 10,000 entries (prevents memory exhaustion)

#### Rate Limit Store Eviction
- Stale records cleaned every 5 minutes via `cleanupStaleRateLimitRecords()`
- Old entries removed if store exceeds 10,000 entries
- No bypass possible via token rotation (each token tracked separately)

#### Rate Limit Headers
- `Retry-After` header returned on 429 response
- Header value = seconds until token can retry

### Security Headers (Helmet)

#### Content Security Policy (CSP)
```
defaultSrc: ["'self"]
scriptSrc: ["'self"]
styleSrc: ["'self", "'unsafe-inline"]
imgSrc: ["'self", "data:", "https:"]
connectSrc: ["'self"]
fontSrc: ["'self"]
objectSrc: ["'none"]
mediaSrc: ["'self"]
frameSrc: ["'none"]
```

#### Additional Headers
- **HSTS**: maxAge 31536000 (1 year), includeSubDomains, preload
- **X-Content-Type-Options**: nosniff
- **X-XSS-Protection**: 1; mode=block
- **X-Frame-Options**: DENY (via CSP frameSrc)
- **Referrer-Policy**: strict-origin-when-cross-origin
- **Cross-Origin-Resource-Policy**: cross-origin

### Webhook Security

#### Signature Verification
- Webhook signature extracted from `X-Hub-Signature-256` header
- `WEBHOOK_SECRET` environment variable required
- HMAC-SHA256 verification using constant-time comparison
- Prevents timing attacks via `crypto.timingSafeEqual()`
- Rejects request with 401 if signature invalid

#### Raw Body Preservation
- `express.json()` configured with custom `verify` callback
- Raw request body stored in `req.rawBody` for signature verification
- Ensures signature computed over exact bytes received

## Authentication & Authorization

### GitHub Token Management
- **Format Validation**: Only GitHub tokens matching patterns `ghu_*`, `ghp_*`, `ghs_*`, `gho_*` are accepted
- **Blacklist Support**: Set `TOKEN_BLACKLIST` environment variable with comma-separated tokens to revoke
- **Rate Limiting**: 10 requests per minute per token
- **Token Storage**: Tokens are never stored in memory; only hashed values are retained for audit purposes

### CSRF Protection
- **Token Generation**: CSRF tokens generated on every GET request via `generateCsrfToken()`, returned in `X-CSRF-Token` response header
- **Expiry**: Tokens expire after 1 hour (3,600 seconds)
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
