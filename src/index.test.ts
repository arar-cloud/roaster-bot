/**
 * Security regression tests for src/index.ts hardening.
 * Run with: npm test (configured as `ts-node-esm src/index.test.ts`)
 *
 * These tests exercise the validation/guard logic extracted into pure helper
 * functions. They do NOT start the HTTP server.
 */
import assert from 'assert';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers under test (must be kept in sync with src/index.ts)
// ---------------------------------------------------------------------------

function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = `sha256=${hmac.digest('hex')}`;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function validateTokenFormat(token: unknown): boolean {
  if (!token || typeof token !== 'string') return false;
  return /^[A-Za-z0-9_\-]{20,255}$/.test(token);
}

function validateMessages(msgs: unknown): string | null {
  if (!Array.isArray(msgs) || msgs.length === 0) return 'messages must be a non-empty array';
  if (msgs.length > 50) return 'messages array exceeds maximum length of 50';
  const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);
  for (const msg of msgs) {
    if (typeof msg !== 'object' || msg === null) return 'Each message must be an object';
    if (typeof (msg as any).role !== 'string' || !ALLOWED_ROLES.has((msg as any).role)) return 'Each message must have a valid role';
    if (typeof (msg as any).content !== 'string') return 'Each message content must be a string';
    if ((msg as any).content.length > 8000) return 'Message content exceeds maximum length of 8000';
  }
  return null;
}

function sanitizeForPrompt(text: string): string {
  return text
    .replace(/\x00/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/```[\s\S]*?```/g, '[code block removed]')
    .trim();
}

const ALLOWED_EVENT_TYPES = new Set(['message', 'content', 'done', 'error']);
function isAllowedEventType(type: unknown): boolean {
  return typeof type === 'string' && ALLOWED_EVENT_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Helpers replicated from index.ts for isolated unit testing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression guard: buf.toString encoding (issue-66d66177a6)
// ---------------------------------------------------------------------------
function captureRawBody(buf: Buffer): string {
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// Regression guard: signature verification (issue-0339adfb79)
// ---------------------------------------------------------------------------
function verifySignature(secret: string, body: string, header: string): boolean {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return header === digest || header === `sha256=${digest}`;
}

const TOKEN_CONTROL_RE = /[\r\n\x00-\x1f]/;
const TOKEN_MODERN_RE  = /^(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]{36,255}$/;
const TOKEN_LEGACY_RE  = /^[a-zA-Z0-9_-]{40,255}$/;

function validateToken(token: string): string | null {
  if (TOKEN_CONTROL_RE.test(token)) return 'control-chars';
  if (!TOKEN_MODERN_RE.test(token) && !TOKEN_LEGACY_RE.test(token)) return 'format';
  return null; // valid
}

const MAX_MESSAGES      = 50;
const MAX_CONTENT_LEN   = 4096;
const MAX_PROMPT_LEN    = 2048;

type Message = { role: string; content: string };

function validateMessages(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0)
    return 'not-array';
  if (messages.length > MAX_MESSAGES)
    return 'too-many';
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) return 'bad-item';
    const msg = m as Record<string, unknown>;
    if (typeof msg.role !== 'string' || typeof msg.content !== 'string')
      return 'bad-shape';
    if ((msg.content as string).length > MAX_CONTENT_LEN)
      return 'content-too-long';
  }
  return null;
}

function sanitizePrompt(raw: string): string {
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, MAX_PROMPT_LEN);
}

function verifyWebhookSignature(body: string, secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(digest));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log('\n=== Webhook signature verification ===');

test('accepts valid HMAC signature', () => {
  const secret = 'mysecret';
  const body = '{"action":"opened"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.strictEqual(verifyWebhookSignature(body, secret, sig), true);
});

test('rejects missing signature header', () => {
  assert.strictEqual(verifyWebhookSignature('body', 'secret', undefined), false);
});

test('rejects tampered body', () => {
  const secret = 'mysecret';
  const body = '{"action":"opened"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.strictEqual(verifyWebhookSignature('{"action":"closed"}', secret, sig), false);
});

test('rejects wrong secret', () => {
  const body = '{"action":"opened"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 'correct').update(body).digest('hex');
  assert.strictEqual(verifyWebhookSignature(body, 'wrong', sig), false);
});

console.log('\n=== Token format validation ===');

test('accepts valid ghp_ prefixed token', () => {
  assert.strictEqual(validateToken('ghp_' + 'a'.repeat(36)), null);
});

test('accepts valid legacy 40-char token', () => {
  assert.strictEqual(validateToken('a'.repeat(40)), null);
});

test('rejects token with newline (injection attempt)', () => {
  assert.notStrictEqual(validateToken('ghp_valid\nX-Extra-Header: evil'), null);
});

test('rejects token with carriage return', () => {
  assert.notStrictEqual(validateToken('ghp_valid\rinjection'), null);
});

test('rejects short token', () => {
  assert.notStrictEqual(validateToken('ghp_short'), null);
});

test('rejects empty token', () => {
  assert.notStrictEqual(validateToken(''), null);
});

console.log('\n=== Messages array validation ===');

test('accepts well-formed messages array', () => {
  const msgs: Message[] = [{ role: 'user', content: 'hello' }];
  assert.strictEqual(validateMessages(msgs), null);
});

test('rejects non-array', () => {
  assert.strictEqual(validateMessages('string'), 'not-array');
});

test('rejects empty array', () => {
  assert.strictEqual(validateMessages([]), 'not-array');
});

test('rejects messages array exceeding MAX_MESSAGES', () => {
  const msgs = Array.from({ length: 51 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  assert.strictEqual(validateMessages(msgs), 'too-many');
});

test('rejects message missing content field', () => {
  assert.strictEqual(validateMessages([{ role: 'user' }]), 'bad-shape');
});

test('rejects message with numeric content', () => {
  assert.strictEqual(validateMessages([{ role: 'user', content: 42 }]), 'bad-shape');
});

test('rejects message content exceeding MAX_CONTENT_LEN', () => {
  const msgs = [{ role: 'user', content: 'x'.repeat(MAX_CONTENT_LEN + 1) }];
  assert.strictEqual(validateMessages(msgs), 'content-too-long');
});

console.log('\n=== Prompt sanitization ===');

test('strips non-printable control characters', () => {
  const raw = 'hello\x00world\x1f!';
  const sanitized = sanitizePrompt(raw);
  assert.ok(!sanitized.includes('\x00'));
  assert.ok(!sanitized.includes('\x1f'));
});

test('preserves newline (\\n) and tab (\\t) which are legitimate', () => {
  const raw = 'line1\nline2\ttabbed';
  assert.ok(sanitizePrompt(raw).includes('\n'));
});

test('truncates prompt exceeding MAX_PROMPT_LEN', () => {
  const raw = 'a'.repeat(MAX_PROMPT_LEN + 100);
  assert.strictEqual(sanitizePrompt(raw).length, MAX_PROMPT_LEN);
});

console.log('\n=== Regression: rawBody encoding (issue-66d66177a6) ===');

test('rawBody utf8 round-trip with multibyte chars', () => {
  const original = 'hello wörld 🌍';
  const buf = Buffer.from(original, 'utf8');
  assert.strictEqual(captureRawBody(buf), original);
});

console.log('\n=== Regression: signature verification (issue-0339adfb79) ===');

test('verifySignature accepts bare hex digest', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ action: 'ping' });
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(verifySignature(secret, body, digest));
});

test('verifySignature accepts sha256= prefixed digest', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ action: 'ping' });
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(verifySignature(secret, body, `sha256=${digest}`));
});

test('verifySignature rejects literal template string (old bug)', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ action: 'ping' });
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(!verifySignature(secret, body, 'sha256=${digest}'));
});

test('verifySignature rejects invalid signature', () => {
  assert.ok(!verifySignature('secret', 'body', 'bad-signature'));
});

console.log('\n=== Results ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
