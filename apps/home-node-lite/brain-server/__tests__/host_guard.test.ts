/**
 * Anti-DNS-rebinding Host allowlist. The brain-server /api/v1/* surface is
 * unauthenticated + loopback-bound; this guard rejects a request whose Host
 * header isn't one we serve, so a DNS-rebound page can't drive the
 * agent-approval gate or read owner-private data using the owner's origin.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { isHostAllowed, registerHostAllowlistGuard } from '../src/host_guard';

function guardedApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHostAllowlistGuard(app);
  // Stand-in for the state-mutating approval gate.
  app.post('/api/v1/workflow/tasks/:id/approve', async () => ({ ok: true }));
  return app;
}

describe('brain-server Host allowlist', () => {
  it('isHostAllowed: loopback (any port) + absent pass; foreign hosts rejected', () => {
    const noExtra = new Set<string>();
    // Loopback on any port — the SPA (real port) and inject's default :80.
    expect(isHostAllowed('127.0.0.1:8402', noExtra)).toBe(true);
    expect(isHostAllowed('localhost:80', noExtra)).toBe(true);
    expect(isHostAllowed('localhost', noExtra)).toBe(true);
    expect(isHostAllowed('[::1]:8402', noExtra)).toBe(true);
    expect(isHostAllowed('', noExtra)).toBe(true);
    // Foreign hostnames — the DNS-rebinding vector.
    expect(isHostAllowed('evil.com', noExtra)).toBe(false);
    expect(isHostAllowed('evil.com:8402', noExtra)).toBe(false);
    // A foreign host that merely embeds a loopback token is still rejected.
    expect(isHostAllowed('localhost.evil.com', noExtra)).toBe(false);
    // Operator-allowlisted proxy host passes (matched on host or hostname).
    const withProxy = new Set(['dina.example.com']);
    expect(isHostAllowed('dina.example.com', withProxy)).toBe(true);
    expect(isHostAllowed('dina.example.com:443', withProxy)).toBe(true);
    expect(isHostAllowed('other.example.com', withProxy)).toBe(false);
  });

  it('rejects a foreign Host with 421 BEFORE the approve route runs', async () => {
    const app = guardedApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t1/approve',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(421);
      expect((res.json() as { error: string }).error).toBe('host_not_allowed');
    } finally {
      await app.close();
    }
  });

  it('allows the same-origin loopback Host (host:port and bare)', async () => {
    const app = guardedApp();
    try {
      const withPort = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t1/approve',
        headers: { host: '127.0.0.1:8402' },
      });
      expect(withPort.statusCode).toBe(200);

      const bare = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t1/approve',
        headers: { host: 'localhost' },
      });
      expect(bare.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
