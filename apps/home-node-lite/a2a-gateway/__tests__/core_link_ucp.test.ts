/**
 * The gateway's calls that hand UCP traffic to Core. An order webhook (UCP plan §3.13
 * step 3): signed with the gateway's key, to Core's one ingress route; only
 * an answer Core marks as written for the client is relayed; and Core gets
 * at most 2 seconds to store the delivery, whatever timeout the link has for
 * other calls, so the merchant hears 503 and retries rather than waiting.
 * An OAuth callback (§3.17) waits for Core's code exchange instead.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';

import { A2A_CORE_ANSWER_HEADER } from '@dina/a2a';
import {
  deriveDIDKey,
  getPublicKey,
  REFRESH_LEASE_MS,
  UCP_OAUTH_CALLBACK_WAIT_MS,
  UCP_OAUTH_INGRESS_ROUTE,
  UCP_WEBHOOK_INGRESS_ROUTE,
  type UcpWebhookEnvelope,
} from '@dina/core';

import { createCoreLink } from '../src/core_link';

let core: Server;
let base: string;
let delayMs = 0;
let marked = true;
const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];

beforeAll(async () => {
  core = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(marked ? { [A2A_CORE_ANSWER_HEADER]: '1' } : {}),
        });
        res.end('{"ucp":{"version":"2026-08-25"}}');
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
});
afterAll(async () => {
  core.closeAllConnections();
  await new Promise((resolve) => core.close(resolve));
});
beforeEach(() => {
  delayMs = 0;
  marked = true;
  seen.length = 0;
});

const seed = new Uint8Array(32).fill(52);
const link = (timeoutMs: number) =>
  createCoreLink({ baseUrl: base, key: { seed, did: deriveDIDKey(getPublicKey(seed)) }, timeoutMs });
const envelope: UcpWebhookEnvelope = {
  path: '/ucp/webhooks/orders',
  query: '',
  headers: { 'webhook-id': 'evt_1' },
  body_b64: Buffer.from('{}').toString('base64'),
};

describe('handing a UCP webhook to Core', () => {
  it('signs it to Core’s ingress route and relays the answer Core marks', async () => {
    expect(await link(5_000).ucpWebhook(envelope)).toEqual({
      ok: true,
      answer: { status: 200, headers: {}, body: { ucp: { version: '2026-08-25' } } },
    });
    expect(seen[0]?.url).toBe(UCP_WEBHOOK_INGRESS_ROUTE);
    expect(seen[0]?.headers['x-did']).toBe(deriveDIDKey(getPublicKey(seed)));
    expect(seen[0]?.headers['x-signature']).toBeTruthy();
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual(envelope);
  });

  it('an answer Core did not mark (Core refusing the gateway itself, say) is not relayed', async () => {
    marked = false;
    expect(await link(5_000).ucpWebhook(envelope)).toEqual({ ok: false, status: 200 });
  });

  it('Core slower than 2 seconds is unreachable, even when other calls may wait longer', async () => {
    delayMs = 2_300;
    expect(await link(10_000).ucpWebhook(envelope)).toEqual({ ok: false, status: 'unreachable' });
  });
});

describe('handing an OAuth callback to Core (UCP plan §3.17)', () => {
  it('signs the parameters to Core’s callback route and waits for its code exchange, longer than a short link timeout', async () => {
    delayMs = 2_300;
    // A code exchange (15 s) and a step-up's wait for a running refresh (its 45 s lease).
    expect(UCP_OAUTH_CALLBACK_WAIT_MS).toBeGreaterThan(15_000 + REFRESH_LEASE_MS);
    const got = await link(1_000).ucpOauthCallback({ code: 'c', state: 's' });
    expect(got).toMatchObject({ ok: true, answer: { status: 200 } });
    expect(seen[0]?.url).toBe(UCP_OAUTH_INGRESS_ROUTE);
    expect(seen[0]?.headers['x-signature']).toBeTruthy();
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ code: 'c', state: 's' });
  });

  it('an answer Core did not mark is not relayed', async () => {
    marked = false;
    expect(await link(5_000).ucpOauthCallback({ state: 's' })).toEqual({ ok: false, status: 200 });
  });
});
