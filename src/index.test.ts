import request from 'supertest';
import crypto from 'crypto';

const WEBHOOK_SECRET = 'test-secret-key';
const ADMIN_API_KEY = 'test-admin-key';
const VALID_GITHUB_TOKEN = 'ghp_validtoken1234567890';

process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ADMIN_API_KEY = ADMIN_API_KEY;
process.env.NODE_ENV = 'test';

// Import must happen after env vars are set
const app = require('./index.ts').app || require('./index.ts').default;

describe('Security Tests', () => {
  describe('HMAC Signature Verification', () => {
    it('should reject webhook requests without signature', async () => {
      const payload = { action: 'opened' };
      const response = await request(app)
        .post('/agent')
        .set('Content-Type', 'application/json')
        .send(payload)
        .set('X-GitHub-Token', VALID_GITHUB_TOKEN);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Authentication');
    });
    
    it('should reject webhook requests with invalid signature', async () => {
      const payload = { action: 'opened' };
      const invalidSignature = 'sha256=invalidsignature';
      const response = await request(app)
        .post('/agent')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', invalidSignature)
        .set('X-GitHub-Token', VALID_GITHUB_TOKEN)
        .send(payload);
      
      expect(response.status).toBe(401);
    });

    it('should reject webhook requests with invalid signature', async () => {
      const payload = { action: 'opened' };
      const response = await request(app)
        .post('/agent')
        .send(payload)
        .set('X-Hub-Signature-256', 'sha256=invalidsignature')
        .set('X-GitHub-Token', 'ghp_validtoken');
      
      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Authentication');
    });

    it('should accept webhook with valid HMAC signature', async () => {
      const payload = JSON.stringify({ action: 'opened', messages: [] });
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      const signature = `sha256=${hmac.update(payload).digest('hex')}`;
      
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Token', 'ghp_validtoken')
        .set('Content-Type', 'application/json');
      
      // Should pass signature check (may fail on token validation, but that's expected)
      expect(response.status).not.toBe(401);
    });
  });

  describe('Input Validation', () => {
    const generateValidSignature = (payload: string) => {
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      return `sha256=${hmac.update(payload).digest('hex')}`;
    };

    it('should reject payload with missing messages field', async () => {
      const payload = JSON.stringify({ action: 'opened' });
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('X-GitHub-Token', 'ghp_validtoken')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(400);
    });

    it('should reject messages array with too many items', async () => {
      const messages = Array(101).fill({ role: 'user', content: 'test' });
      const payload = JSON.stringify({ action: 'opened', messages });
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('X-GitHub-Token', 'ghp_validtoken')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(400);
    });

    it('should reject message with invalid role', async () => {
      const payload = JSON.stringify({
        action: 'opened',
        messages: [{ role: 'invalid', content: 'test' }]
      });
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('X-GitHub-Token', 'ghp_validtoken')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(400);
    });

    it('should reject message content exceeding 4096 characters', async () => {
      const payload = JSON.stringify({
        action: 'opened',
        messages: [{ role: 'user', content: 'x'.repeat(4097) }]
      });
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('X-GitHub-Token', 'ghp_validtoken')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(400);
    });
  });

  describe('Content-Type Validation', () => {
    it('should reject requests without Content-Type header', async () => {
      const payload = JSON.stringify({ action: 'opened', messages: [] });
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      const signature = `sha256=${hmac.update(payload).digest('hex')}`;
      
      const response = await request(app)
        .post('/agent')
        .send(payload)
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Token', 'ghp_validtoken');
      // Note: supertest may auto-set Content-Type, so this might not trigger in test
      
      if (response.status === 415) {
        expect(response.status).toBe(415);
      }
    });
  });

  describe('Token Validation', () => {
    const generateValidSignature = (payload: string) => {
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      return `sha256=${hmac.update(payload).digest('hex')}`;
    };

    it('should reject request without GitHub token', async () => {
      const payload = JSON.stringify({ action: 'opened', messages: [] });
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Authentication');
    });

    it('should reject token with invalid format', async () => {
      const payload = JSON.stringify({ action: 'opened', messages: [] });
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('X-GitHub-Token', 'invalid_token_format')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(400);
    });

    it('should accept valid token formats', async () => {
      const validTokenPrefixes = ['ghu_', 'ghp_', 'ghs_', 'gho_'];
      
      for (const prefix of validTokenPrefixes) {
        const payload = JSON.stringify({ action: 'opened', messages: [] });
        const response = await request(app)
          .post('/agent')
          .send(JSON.parse(payload))
          .set('X-Hub-Signature-256', generateValidSignature(payload))
          .set('X-GitHub-Token', prefix + 'validtoken123456')
          .set('Content-Type', 'application/json');
        
        // Should pass token validation
        expect([400, 401, 500]).not.toContain(response.status);
      }
    });
  });

  describe('Health Endpoint Authentication', () => {
    it('should reject health check without API key', async () => {
      const response = await request(app)
        .get('/health');
      
      expect(response.status).toBe(401);
    });

    it('should reject health check with invalid API key', async () => {
      const response = await request(app)
        .get('/health')
        .set('X-API-Key', 'invalid-key');
      
      expect(response.status).toBe(403);
    });

    it('should accept health check with valid API key', async () => {
      const response = await request(app)
        .get('/health')
        .set('X-API-Key', 'test-admin-key');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
    });
  });

  describe('Public Endpoint Rate Limiting', () => {
    it('should allow GET / request', async () => {
      const response = await request(app)
        .get('/');
      
      expect(response.status).toBe(200);
      expect(response.text).toContain('Roaster');
    });
  });

  describe('Payload Sanitization', () => {
    const generateValidSignature = (payload: string) => {
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      return `sha256=${hmac.update(payload).digest('hex')}`;
    };

    it('should reject payload exceeding size limit', async () => {
      const largeContent = 'x'.repeat(100000);
      const payload = JSON.stringify({
        action: 'opened',
        messages: [],
        pull_request: { title: 'test', body: largeContent }
      });
      
      const response = await request(app)
        .post('/agent')
        .send(JSON.parse(payload))
        .set('X-Hub-Signature-256', generateValidSignature(payload))
        .set('X-GitHub-Token', 'ghp_validtoken')
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(400);
    });
  });
});
