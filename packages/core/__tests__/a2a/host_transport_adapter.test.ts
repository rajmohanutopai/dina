/** A2A's host transport over a policy socket: A2A's own behaviour on any host. */
import { a2aTransportFromPolicySocket } from '../../src/a2a/host_transport';

import type { PolicySocketRequest, PolicySocketResult } from '@dina/net-policy';

function socketReturning(result: PolicySocketResult) {
  const seen: PolicySocketRequest[] = [];
  const transport = a2aTransportFromPolicySocket(async (r) => {
    seen.push(r);
    return result;
  });
  return { transport, seen };
}

const ok = (body: string, status = 200): PolicySocketResult => ({
  ok: true,
  status,
  bodyBytes: new TextEncoder().encode(body),
  rawHeaders: [['content-type', 'application/json']],
  connectedAddress: '203.0.114.7',
});

describe('A2A over the policy socket', () => {
  it('sends a JSON POST with TLS 1.2 or later and reads the JSON answer', async () => {
    const { transport, seen } = socketReturning(ok('{"jsonrpc":"2.0","id":1,"result":{}}'));
    const r = await transport({
      method: 'POST',
      url: 'https://agent.example/a2a',
      headers: { 'a2a-version': '1.0' },
      body: '{"jsonrpc":"2.0"}',
      maxResponseBytes: 1024,
      timeoutMs: 1000,
    });
    expect(r).toEqual({
      ok: true,
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":{}}',
      connectedAddress: '203.0.114.7',
    });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      headers: { 'a2a-version': '1.0', 'content-type': 'application/json' },
      accept: 'json',
      minTls: 'TLSv1.2',
      readAuthErrorBodies: false,
    });
    expect(new TextDecoder().decode(seen[0]?.body)).toBe('{"jsonrpc":"2.0"}');
  });

  it('keeps the caller content type (a webhook push) and asks for the status only', async () => {
    const { transport, seen } = socketReturning(ok('', 204));
    await transport({
      method: 'POST',
      url: 'https://hook.example/push',
      headers: {},
      body: '{}',
      contentType: 'application/a2a+json',
      response: 'status',
      maxResponseBytes: 0,
      timeoutMs: 1000,
    });
    expect(seen[0]).toMatchObject({
      accept: 'status',
      headers: { 'content-type': 'application/a2a+json' },
    });
  });

  it('refuses a body that is not UTF-8, and passes socket failures through', async () => {
    const bad: PolicySocketResult = {
      ...(ok('') as Extract<PolicySocketResult, { ok: true }>),
      bodyBytes: new Uint8Array([0xff, 0xfe]),
    };
    expect(
      await socketReturning(bad).transport({
        method: 'GET',
        url: 'https://a.example/',
        headers: {},
        maxResponseBytes: 10,
        timeoutMs: 10,
      }),
    ).toEqual({ ok: false, error: 'bad_encoding', sent: true });
    expect(
      await socketReturning({ ok: false, error: 'address_blocked', sent: false }).transport({
        method: 'GET',
        url: 'https://a.example/',
        headers: {},
        maxResponseBytes: 10,
        timeoutMs: 10,
      }),
    ).toEqual({ ok: false, error: 'address_blocked', sent: false });
  });
});
