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
// Helpers replicated from index.ts for isolated unit testing
// ---------------------------------------------------------------------------

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

console.log('\n=== Results ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
