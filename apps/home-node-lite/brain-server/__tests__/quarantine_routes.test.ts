/**
 * `/api/v1/d2d/quarantine` Fastify routes — the SPA's quarantine-review data
 * layer, a thin proxy over CoreClient (mobile reads the in-process store).
 * Drives the routes with a MockCoreClient so a handler/path/shape regression
 * fails here without standing up core-server.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { type QuarantinedMessage } from '@dina/core';
import { MockCoreClient } from '@dina/test-harness';

import { registerQuarantineApiRoutes } from '../src/routes/quarantine';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerQuarantineApiRoutes(app, { core });
  return app;
}

function qmsg(over: Partial<QuarantinedMessage> = {}): QuarantinedMessage {
  return {
    id: 'q-1',
    senderDID: 'did:plc:stranger',
    messageType: 'coordination.request',
    body: 'hello from a stranger',
    receivedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 1000,
    ...over,
  };
}

describe('Brain server — /api/v1/d2d/quarantine HTTP wiring', () => {
  it('GET returns { messages } from the CoreClient', async () => {
    const core = new MockCoreClient();
    core.quarantinedResult = [qmsg({ id: 'q-a', senderDID: 'did:plc:x' })];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/d2d/quarantine' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { messages: QuarantinedMessage[] };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.senderDID).toBe('did:plc:x');
    } finally {
      await app.close();
    }
  });

  it('POST accept forwards sender_did (+ label) and returns released + count', async () => {
    const core = new MockCoreClient();
    core.quarantinedResult = [
      qmsg({ id: 'q-a', senderDID: 'did:plc:x' }),
      qmsg({ id: 'q-b', senderDID: 'did:plc:x' }),
      qmsg({ id: 'q-c', senderDID: 'did:plc:y' }),
    ];
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/d2d/quarantine/accept',
        payload: { sender_did: 'did:plc:x', sender_label: 'Stranger X' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { released: QuarantinedMessage[]; count: number };
      expect(body.count).toBe(2); // both of X's messages released; Y untouched
      const call = core.calls.find((c) => c.method === 'acceptQuarantinedSender');
      expect(call?.args).toEqual(['did:plc:x', 'Stranger X']);
      // The accepted sender's messages left the buffer.
      expect(core.quarantinedResult.map((m) => m.senderDID)).toEqual(['did:plc:y']);
    } finally {
      await app.close();
    }
  });

  it('POST block forwards sender_did and returns blocked_count', async () => {
    const core = new MockCoreClient();
    core.quarantinedResult = [qmsg({ senderDID: 'did:plc:z' })];
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/d2d/quarantine/block',
        payload: { sender_did: 'did:plc:z' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { blocked_count: number }).blocked_count).toBe(1);
      const call = core.calls.find((c) => c.method === 'blockQuarantinedSender');
      expect(call?.args).toEqual(['did:plc:z', '']);
    } finally {
      await app.close();
    }
  });

  it('accept AND block require sender_did (400)', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const acceptMissing = await app.inject({
        method: 'POST',
        url: '/api/v1/d2d/quarantine/accept',
        payload: {},
      });
      expect(acceptMissing.statusCode).toBe(400);

      const blockMissing = await app.inject({
        method: 'POST',
        url: '/api/v1/d2d/quarantine/block',
        payload: { sender_did: '   ' }, // whitespace trims to empty
      });
      expect(blockMissing.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('surfaces a Core failure on GET/accept/block as 502', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      core.throwOn.listQuarantined = new Error('core down');
      expect((await app.inject({ method: 'GET', url: '/api/v1/d2d/quarantine' })).statusCode).toBe(
        502,
      );

      core.throwOn.acceptQuarantinedSender = new Error('core down');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/d2d/quarantine/accept',
            payload: { sender_did: 'did:plc:x' },
          })
        ).statusCode,
      ).toBe(502);

      core.throwOn.blockQuarantinedSender = new Error('core down');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/d2d/quarantine/block',
            payload: { sender_did: 'did:plc:x' },
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
});
