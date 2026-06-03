import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import app from './index';
import http from 'http';

describe('POST /agent endpoint', () => {
  let server: http.Server;

  before(() => {
    server = app.listen(3001);
  });

  after(() => {
    server.close();
  });

  it('should reject requests without X-GitHub-Token header', async () => {
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/agent',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    return new Promise((resolve, reject) => {
      req.on('response', (res) => {
        assert.equal(res.statusCode, 400);
        resolve(null);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ userMessages: [] }));
    });
  });

  it('should reject requests without userMessages in body', async () => {
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/agent',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Token': 'test-token'
      }
    });
    
    return new Promise((resolve, reject) => {
      req.on('response', (res) => {
        assert.equal(res.statusCode, 400);
        resolve(null);
      });
      req.on('error', reject);
      req.end(JSON.stringify({}));
    });
  });
});
