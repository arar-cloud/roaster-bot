# Security Hardening Documentation

## Overview
This document outlines the security controls implemented in the roaster-bot application, including authentication, authorization, input validation, and secrets management.

## Authentication & Authorization

### Webhook Authentication
- **Method**: HMAC-SHA256 signature verification
- **Header**: `X-Hub-Signature-256`
- **Implementation**: Timing-safe comparison to prevent timing attacks
- **Secret**: `WEBHOOK_SECRET` environment variable (required at startup)

### GitHub Token Validation
- **Header**: `X-GitHub-Token`
- **Format Validation**: Tokens must start with `ghu_`, `ghp_`, `ghs_`, or `gho_`
- **Security**: Token is never logged, cached, or exposed in error messages
- **Isolation**: Token is scoped to CopilotClient initialization only

### Admin API Key Authentication
- **Header**: `X-API-Key`
- **Usage**: Required for health check and management endpoints
- **Implementation**: Timing-safe comparison to prevent timing attacks
- **Secret**: `ADMIN_API_KEY` environment variable

## Input Validation

### Content-Type Validation
- **Requirement**: All POST requests must have `Content-Type: application/json`
- **Response**: 415 Unsupported Media Type for non-JSON requests

### Webhook Payload Validation
- **Size Limit**: 64KB maximum payload size
- **Field Validation**: 
  - `action`: Required string, max 128 characters
  - `pull_request.title`: Max 1024 characters, HTML-escaped
  - `pull_request.body`: Max 65536 characters, HTML-escaped
  - `commits[]`: Max 100 commits, message max 4096 characters, HTML-escaped

### User Message Validation
- **Array Requirements**: 1-100 messages per request
- **Message Fields**:
  - `role`: Required, must be "user" or "assistant"
  - `content`: Required string, 1-4096 characters
- **Type Safety**: All fields are strictly validated before processing

## Rate Limiting

### Global Rate Limiter
- **Limit**: 100 requests per 15 minutes
- **Applied to**: GET / endpoint

### Strict Rate Limiter (Webhook Endpoint)
- **Limit**: 20 requests per 15 minutes
- **Applied to**: POST /agent endpoint
- **Purpose**: Prevent abuse of AI/Copilot endpoint

## CORS Configuration

### Allowed Origins
- `https://github.com`
- `https://api.github.com`

### Strict Validation
- Origin header must be present and match whitelist
- Requests without origin header are rejected

## Error Handling

### Client-Side Error Responses
- All error messages are sanitized
- No stack traces exposed
- No internal state information disclosed
- Includes `eventId` for support reference

### Server-Side Logging
- Full error context is logged server-side with timestamps
- Sensitive values are automatically masked in logs
- All logs follow structured JSON format with redaction

## Payload Injection Prevention

### HTML Escaping
All user-supplied content from GitHub webhooks is HTML-escaped before:
- Storing in memory
- Sending to external APIs
- Processing by Copilot/OpenAI

### Prevented Attack Vectors
- Script injection in PR titles/bodies
- Markup injection in commit messages
- Prompt injection attacks on AI models

## Code Safety

### No Dynamic Code Execution
- **Verified**: No `eval()`, `Function()`, or `exec()` calls in codebase
- **Copilot Responses**: Never dynamically executed, always streamed to client
- **User Input**: Never used as code or template

## Secrets Management

### Environment Variables

#### Required at Startup
- `WEBHOOK_SECRET`: GitHub webhook signature secret (enforced via startup check)
- `ADMIN_API_KEY`: Admin API key for protected endpoints (recommended)
- `GITHUB_TOKEN` (alternate): Can be used instead of header token
- `PORT`: Server port (default: 3000)

#### Secret Masking
All sensitive values in logs are masked:
- First 4 characters visible: `ghu_****...`
- Ensures secrets never appear in logs

### Rotation Schedule

#### Webhook Secret (WEBHOOK_SECRET)
- **Rotation Interval**: Every 90 days
- **Process**: 
  1. Generate new secret
  2. Update `WEBHOOK_SECRET` environment variable
  3. Restart server (connections are stateless)
  4. GitHub webhook configuration remains unchanged (uses header signature)
- **Audit**: Log all secret rotations with timestamp

#### Admin API Key (ADMIN_API_KEY)
- **Rotation Interval**: Every 60 days
- **Process**:
  1. Generate new key
  2. Update `ADMIN_API_KEY` environment variable
  3. Restart server
- **Audit**: Log all key access attempts

#### GitHub Tokens
- **Client Tokens**: Provided per-request via header, not stored
- **Rotation**: Managed by GitHub token provider (24-hour expiry recommended)
- **Service Tokens**: If using service account, rotate every 30 days

### Audit Logging

#### Events Logged
- Webhook signature verification attempts (success/failure)
- Token validation failures
- Invalid payload rejections
- Rate limit hits
- Health check access (with API key validation)
- Copilot client initialization
- Session errors (without sensitive details)

#### Log Format
```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "info|warn|error",
  "message": "Human-readable message",
  "eventId": "UUID for correlation",
  "clientIp": "IP address",
  "additionalContext": "values with secrets masked"
}
```

## Security Headers

### Implemented via Helmet
- **HSTS**: 1 year expiry with includeSubDomains and preload
- **X-Frame-Options**: DENY (prevent clickjacking)
- **X-Content-Type-Options**: nosniff (prevent MIME-sniffing)
- **X-XSS-Protection**: Enabled
- **CSP**: 
  - `default-src: 'self'`
  - `style-src: 'self' 'unsafe-inline'` (for embedded styles)
  - `script-src: 'self'` (no inline scripts)
  - `connect-src: 'self'` (restrict external connections)

## Testing

### Security Test Coverage
Run security tests:
```bash
npm test
```

### Test Scenarios
1. **HMAC Verification**: Signature validation and timing-safe comparison
2. **Input Validation**: Payload structure, size, and type checks
3. **Token Validation**: GitHub token format and presence
4. **Rate Limiting**: Request throttling per endpoint
5. **Authentication**: API key validation for protected endpoints
6. **Error Handling**: Sanitization and logging
7. **Payload Sanitization**: HTML escaping and injection prevention

## Deployment Checklist

- [ ] Set `WEBHOOK_SECRET` in production environment
- [ ] Set `ADMIN_API_KEY` in production environment (or remove if not needed)
- [ ] Verify `NODE_ENV=production` is set
- [ ] Enable HTTPS only (use reverse proxy like nginx)
- [ ] Configure firewall to allow only GitHub IPs (if possible)
- [ ] Set up log aggregation and monitoring
- [ ] Schedule secrets rotation (see Rotation Schedule above)
- [ ] Run security tests before each deployment
- [ ] Monitor rate limiting metrics
- [ ] Review audit logs regularly

## Incident Response

### Suspected Secret Compromise
1. Immediately rotate the compromised secret
2. Review audit logs for unauthorized access
3. Invalidate affected sessions (stateless, restart server)
4. Update GitHub webhook configuration if necessary
5. Document incident with timestamp and impact

### Rate Limit Abuse
1. Check audit logs for source IPs
2. Update rate limit thresholds if needed
3. Consider IP-based blocking at firewall level
4. Notify GitHub of potential attack

## References
- [OWASP: Webhook Security](https://owasp.org/www-community/attacks/Webhook_Attack)
- [NIST: Cryptographic Key Management](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/nodejs-security/)
- [GitHub: Webhook Signature Verification](https://docs.github.com/en/developers/webhooks-and-events/webhooks/securing-your-webhooks)
