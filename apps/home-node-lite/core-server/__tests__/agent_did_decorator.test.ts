/**
 * Task 4.28 — agent-DID request decorator tests.
 */

import { pino } from 'pino';
import { Writable } from 'node:stream';
import { createServer } from '../src/server';
import {
  setAgentContext,
  requireAgentContext,
} from '../src/auth/agent_did_decorator';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'info', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

describe('agent-DID decorator (task 4.28)', () => {
  it('decorates every request with agentDid / agentCallerType / agentSessionId defaulted to null', async () => {
    const app = await createServer({
      config: baseConfig(),
      logger: pino({ level: 'silent' }),
    });
    app.get('/probe', async (req) => ({
      agentDid: req.agentDid,
      agentCallerType: req.agentCallerType,
      agentSessionId: req.agentSessionId,
    }));

    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.json()).toEqual({
      agentDid: null,
      agentCallerType: null,
      agentSessionId: null,
    });
    await app.close();
  });

  it('setAgentContext populates did + callerType + sessionId', async () => {
    const app = await createServer({
      config: baseConfig(),
      logger: pino({ level: 'silent' }),
    });
    app.get('/mark', async (req) => {
      setAgentContext(req, {
        did: 'did:plc:alice',
        callerType: 'brain',
        sessionId: 'sess-42',
      });
      return {
        agentDid: req.agentDid,
        agentCallerType: req.agentCallerType,
        agentSessionId: req.agentSessionId,
      };
    });

    const res = await app.inject({ method: 'GET', url: '/mark' });
    expect(res.json()).toEqual({
      agentDid: 'did:plc:alice',
      agentCallerType: 'brain',
      agentSessionId: 'sess-42',
    });
    await app.close();
  });

  it('setAgentContext without sessionId defaults agentSessionId to null', async () => {
    const app = await createServer({
      config: baseConfig(),
      logger: pino({ level: 'silent' }),
    });
    app.get('/mark', async (req) => {
      setAgentContext(req, { did: 'did:plc:admin', callerType: 'admin' });
      return { agentSessionId: req.agentSessionId };
    });
    const res = await app.inject({ method: 'GET', url: '/mark' });
    expect(res.json()).toEqual({ agentSessionId: null });
    await app.close();
  });

  it('requireAgentContext returns the bundled context when set', async () => {
    const app = await createServer({
      config: baseConfig(),
      logger: pino({ level: 'silent' }),
    });
    app.get('/probe', async (req) => {
      setAgentContext(req, { did: 'did:plc:a', callerType: 'device' });
      const ctx = requireAgentContext(req);
      return ctx;
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.json()).toEqual({ did: 'did:plc:a', callerType: 'device' });
    await app.close();
  });

  it('requireAgentContext throws when context is unset (no auth ran)', async () => {
    const app = await createServer({
      config: baseConfig(),
      logger: pino({ level: 'silent' }),
    });
    app.get('/probe', async (req) => {
      // No setAgentContext call — handler should blow up.
      requireAgentContext(req);
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    // The throw gets caught by our 4.8 setErrorHandler → 500 masked.
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal server error' });
    await app.close();
  });

  it('setAgentContext also forwards DID to the log-binding context (task 4.7)', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        const text = chunk.toString('utf8');
        for (const raw of text.split('\n').filter(Boolean)) {
          try {
            lines.push(JSON.parse(raw) as Record<string, unknown>);
          } catch {
            // ignore
          }
        }
        cb();
      },
    });
    const logger: Logger = pino(
      {
        level: 'info',
        formatters: { level: (label) => ({ level: label }) },
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
        messageKey: 'msg',
        base: null,
      },
      sink,
    );
    const app = await createServer({ config: baseConfig(), logger });
    app.get('/mark', async (req) => {
      setAgentContext(req, {
        did: 'did:plc:logtest',
        callerType: 'brain',
      });
      req.log.info('after agent-context set');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/mark' });
    await app.close();

    const emitted = lines.find((l) => l['msg'] === 'after agent-context set');
    expect(emitted).toBeDefined();
    expect(emitted?.['did']).toBe('did:plc:logtest');
  });

  it('per-request isolation: one request setting the context does NOT affect another', async () => {
    const app = await createServer({
      config: baseConfig(),
      logger: pino({ level: 'silent' }),
    });
    app.get('/a', async (req) => {
      setAgentContext(req, { did: 'did:plc:A', callerType: 'brain' });
      return { agentDid: req.agentDid };
    });
    app.get('/b', async (req) => ({ agentDid: req.agentDid }));

    const a = await app.inject({ method: 'GET', url: '/a' });
    const b = await app.inject({ method: 'GET', url: '/b' });
    expect(a.json()).toEqual({ agentDid: 'did:plc:A' });
    expect(b.json()).toEqual({ agentDid: null });
    await app.close();
  });
});
