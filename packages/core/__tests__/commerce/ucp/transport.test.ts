/**
 * The UCP transport (plan §3.6 steps 5–7, 5a): MCP sessions against mock
 * servers that refuse calls before initialization, end sessions between
 * calls, answer in SSE, or skip the lifecycle (Shopify); REST paths, headers
 * and errors read by code with Retry-After.
 */
import { UcpTransport } from '../../../src/commerce/ucp/transport';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const PROFILE = 'https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/.well-known/ucp';
const MCP = 'https://shop.example/ucp/mcp';
const REST = 'https://shop.example/ucp/v1';

interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  sse?: boolean;
}
const answer = (a: Answer): UcpFetchResult => {
  const text =
    a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
  return {
    ok: true,
    status: a.status,
    bodyBytes: new TextEncoder().encode(
      a.sse === true ? `event: message\ndata: ${text}\n\n` : text,
    ),
    headers: {
      'content-type': a.sse === true ? 'text/event-stream' : 'application/json',
      ...(a.headers ?? {}),
    },
    connectedAddress: '203.0.114.7',
  };
};

interface Sent {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}

/** An MCP server: lifecycle on or off, session expiry on demand, JSON or SSE. */
function mcpServer(opts: { lifecycle: boolean; sse?: boolean }) {
  const sent: Sent[] = [];
  let sessions = 0;
  let live: string | null = null;
  const state = { expire: () => (live = null) };
  const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    const body = new TextDecoder().decode(r.body ?? new Uint8Array());
    sent.push({ method: r.method, url: r.url, headers: r.headers, body });
    const msg = JSON.parse(body) as {
      id?: string;
      method: string;
      params?: { name?: string; arguments?: unknown };
    };
    if (msg.method === 'initialize') {
      if (!opts.lifecycle)
        return answer({
          status: 200,
          body: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } },
        });
      live = `s${++sessions}`;
      return answer({
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-11-25', capabilities: {} },
        },
        headers: { 'mcp-session-id': live },
      });
    }
    if (msg.method === 'notifications/initialized') return answer({ status: 202 });
    if (opts.lifecycle) {
      const sid = r.headers['mcp-session-id'];
      if (sid === undefined) return answer({ status: 400, body: { error: 'initialize first' } });
      if (sid !== live) return answer({ status: 404 });
      if (r.headers['mcp-protocol-version'] !== '2025-11-25') return answer({ status: 400 });
    }
    const result = {
      structuredContent: { ucp: { version: '2026-08-25', status: 'success' }, products: [] },
    };
    return answer({
      status: 200,
      body: { jsonrpc: '2.0', id: msg.id, result },
      sse: opts.sse === true,
    });
  };
  return { sent, fetch, state };
}

let n = 0;
const ids = () => `id-${++n}`;

describe('MCP', () => {
  it('initializes once, then calls with the session id and protocol version; JSON answers', async () => {
    const s = mcpServer({ lifecycle: true });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    const call = {
      transport: 'mcp' as const,
      endpoint: MCP,
      profileUrl: PROFILE,
      operation: 'search_catalog' as const,
      payload: { query: 'tea' },
    };
    expect(await t.call(call)).toMatchObject({ ok: true, value: { products: [] } });
    expect(await t.call(call)).toMatchObject({ ok: true });
    expect(s.sent.map((x) => JSON.parse(x.body).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'tools/call',
    ]);
    const tool = s.sent[2] as Sent;
    expect(tool.headers).toMatchObject({
      'mcp-session-id': 's1',
      'mcp-protocol-version': '2025-11-25',
      accept: 'application/json, text/event-stream',
    });
    expect(JSON.parse(tool.body).params.arguments.meta['ucp-agent'].profile).toBe(PROFILE);
  });

  it('a session that ended between calls: a new session, and the same bytes sent again', async () => {
    const s = mcpServer({ lifecycle: true });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    const call = {
      transport: 'mcp' as const,
      endpoint: MCP,
      profileUrl: PROFILE,
      operation: 'create_cart' as const,
      payload: { line_items: [] },
      idempotencyKey: 'key-1',
    };
    await t.call(call);
    s.state.expire();
    const before = s.sent.length;
    expect(await t.call(call)).toMatchObject({ ok: true });
    const after = s.sent.slice(before);
    expect(after.map((x) => JSON.parse(x.body).method)).toEqual([
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    // The resend is byte-identical: same JSON-RPC id, same idempotency key.
    expect((after[3] as Sent).body).toBe((after[0] as Sent).body);
    expect(JSON.parse((after[3] as Sent).body).params.arguments.meta['idempotency-key']).toBe(
      'key-1',
    );
    expect((after[3] as Sent).headers['mcp-session-id']).toBe('s2');
  });

  it('a server that skips the lifecycle (Shopify): calls go without session headers and work', async () => {
    const s = mcpServer({ lifecycle: false });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    const r = await t.call({
      transport: 'mcp',
      endpoint: MCP,
      profileUrl: PROFILE,
      operation: 'search_catalog',
      payload: { query: 'tea' },
    });
    expect(r).toMatchObject({ ok: true });
    const tool = s.sent.find((x) => JSON.parse(x.body).method === 'tools/call') as Sent;
    expect(tool.headers['mcp-session-id']).toBeUndefined();
    expect(tool.headers['mcp-protocol-version']).toBeUndefined();
  });

  it('reads an SSE answer', async () => {
    const s = mcpServer({ lifecycle: true, sse: true });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    expect(
      await t.call({
        transport: 'mcp',
        endpoint: MCP,
        profileUrl: PROFILE,
        operation: 'search_catalog',
        payload: { query: 'x' },
      }),
    ).toMatchObject({ ok: true, value: { products: [] } });
  });

  it('reads a JSON-RPC error by error.data.code with retry_after; a network failure says whether it was sent', async () => {
    const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
      const msg = JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array()));
      if (msg.method !== 'tools/call')
        return answer({
          status: 200,
          body: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'x' } },
        });
      return answer({
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32000,
            message: 'busy',
            data: { code: 'PROFILE_UNREACHABLE', retry_after: 30 },
          },
        },
      });
    };
    const t = new UcpTransport({ fetch, randomId: ids });
    expect(
      await t.call({
        transport: 'mcp',
        endpoint: MCP,
        profileUrl: PROFILE,
        operation: 'get_order',
        id: 'o1',
      }),
    ).toEqual({
      ok: false,
      kind: 'transport',
      error: { status: -32000, httpStatus: 200, code: 'profile_unreachable', retryAfter: 30 },
    });
    const down = new UcpTransport({
      fetch: async () => ({ ok: false, error: 'timeout', sent: true }),
      randomId: ids,
    });
    expect(
      await down.call({
        transport: 'mcp',
        endpoint: MCP,
        profileUrl: PROFILE,
        operation: 'get_order',
        id: 'o1',
      }),
    ).toEqual({
      ok: false,
      kind: 'network',
      error: 'timeout',
      sent: true,
    });
  });

  it('an answer for another JSON-RPC id is malformed', async () => {
    const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
      const msg = JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array()));
      if (msg.method !== 'tools/call')
        return answer({
          status: 200,
          body: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'x' } },
        });
      return answer({
        status: 200,
        body: { jsonrpc: '2.0', id: 'someone-else', result: { structuredContent: {} } },
      });
    };
    const t = new UcpTransport({ fetch, randomId: ids });
    expect(
      await t.call({
        transport: 'mcp',
        endpoint: MCP,
        profileUrl: PROFILE,
        operation: 'get_order',
        id: 'o1',
      }),
    ).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'id_mismatch',
    });
  });
});

describe('MCP, after review', () => {
  /** A server whose tools/call answers are scripted; initialize answers as asked. */
  function scripted(opts: { init: () => Answer; tool: () => Answer }) {
    const sent: Sent[] = [];
    const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
      const body = new TextDecoder().decode(r.body ?? new Uint8Array());
      sent.push({ method: r.method, url: r.url, headers: r.headers, body });
      const msg = JSON.parse(body) as { id?: string; method: string };
      if (msg.method === 'initialize') {
        const a = opts.init();
        return answer(
          a.body === 'ok'
            ? {
                status: 200,
                body: { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25' } },
                headers: { 'mcp-session-id': 's1' },
              }
            : a,
        );
      }
      if (msg.method === 'notifications/initialized') return answer({ status: 202 });
      const a = opts.tool();
      const b = a.body as Record<string, unknown> | undefined;
      return answer({
        ...a,
        body: b === undefined ? undefined : { jsonrpc: '2.0', id: msg.id, ...b },
      });
    };
    return { sent, fetch };
  }
  const call = {
    transport: 'mcp' as const,
    endpoint: MCP,
    profileUrl: PROFILE,
    operation: 'get_order' as const,
    id: 'o1',
  };

  it('a JSON-RPC error carried with its HTTP status (429, 503, 424) is read by error.data, Retry-After as fallback', async () => {
    const cases: [Answer, Record<string, unknown>][] = [
      [
        {
          status: 429,
          body: {
            error: {
              code: -32000,
              message: 'slow down',
              data: { code: 'RATE_LIMITED', retry_after: 60 },
            },
          },
        },
        { status: -32000, code: 'rate_limited', retryAfter: 60 },
      ],
      [
        {
          status: 503,
          body: { error: { code: -32000, message: 'later', data: {} } },
          headers: { 'retry-after': '30' },
        },
        { status: -32000, code: 'unknown', retryAfter: 30 },
      ],
      [
        {
          status: 424,
          body: { error: { code: -32001, message: 'x', data: { code: 'PROFILE_UNREACHABLE' } } },
        },
        { status: -32001, code: 'profile_unreachable' },
      ],
    ];
    for (const [tool, error] of cases) {
      const s = scripted({ init: () => ({ status: 200, body: 'ok' }), tool: () => tool });
      const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
      expect(await t.call(call)).toEqual({
        ok: false,
        kind: 'transport',
        error: { ...error, httpStatus: tool.status },
      });
    }
  });

  it('an initialize that fails for now (503) is tried again on the next call; a plain refusal (405) is remembered', async () => {
    let initAnswers: Answer[] = [{ status: 503 }, { status: 200, body: 'ok' }];
    const ok = {
      status: 200,
      body: { result: { structuredContent: { ucp: { version: '2026-08-25' } } } },
    };
    const s = scripted({
      init: () => initAnswers.shift() ?? { status: 200, body: 'ok' },
      tool: () => ok,
    });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    await t.call(call);
    await t.call(call);
    const methods = s.sent.map((x) => JSON.parse(x.body).method);
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(2);
    expect(s.sent[s.sent.length - 1]?.headers['mcp-session-id']).toBe('s1');
    initAnswers = [];
    const refusing = scripted({ init: () => ({ status: 405 }), tool: () => ok });
    const t2 = new UcpTransport({ fetch: refusing.fetch, randomId: ids });
    await t2.call(call);
    await t2.call(call);
    expect(refusing.sent.filter((x) => JSON.parse(x.body).method === 'initialize')).toHaveLength(1);
  });

  it('two calls meeting the same ended session at once both succeed on one new session', async () => {
    const s = mcpServer({ lifecycle: true });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    const c = {
      transport: 'mcp' as const,
      endpoint: MCP,
      profileUrl: PROFILE,
      operation: 'search_catalog' as const,
      payload: { query: 'x' },
    };
    await t.call(c);
    s.state.expire();
    const [a, b] = await Promise.all([t.call(c), t.call(c)]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(s.sent.filter((x) => JSON.parse(x.body).method === 'initialize')).toHaveLength(2);
  });

  it('every MCP post carries UCP-Agent, and each call the cap of its kind', async () => {
    const caps: [string, number][] = [];
    const s = mcpServer({ lifecycle: true });
    const t = new UcpTransport({
      fetch: async (r) => {
        caps.push([
          JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array())).params?.name ?? '-',
          r.maxResponseBytes,
        ]);
        expect(r.headers['ucp-agent']).toBe(`profile="${PROFILE}"`);
        return s.fetch(r);
      },
      randomId: ids,
    });
    await t.call({
      transport: 'mcp',
      endpoint: MCP,
      profileUrl: PROFILE,
      operation: 'search_catalog',
      payload: { query: 'x' },
    });
    await t.call({
      transport: 'mcp',
      endpoint: MCP,
      profileUrl: PROFILE,
      operation: 'get_order',
      id: 'o1',
    });
    expect(caps.filter(([n]) => n !== '-')).toEqual([
      ['search_catalog', 2 * 1024 * 1024],
      ['get_order', 512 * 1024],
    ]);
  });

  it('ids are UUIDs made without crypto.randomUUID (Hermes has none)', async () => {
    const saved = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      const s = mcpServer({ lifecycle: true });
      const t = new UcpTransport({ fetch: s.fetch });
      expect(
        await t.call({
          transport: 'mcp',
          endpoint: MCP,
          profileUrl: PROFILE,
          operation: 'get_order',
          id: 'o1',
        }),
      ).toMatchObject({ ok: true });
      expect(JSON.parse((s.sent[0] as Sent).body).id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: saved, configurable: true });
    }
  });
});

describe('REST', () => {
  function restServer(a: Answer) {
    const sent: Sent[] = [];
    const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
      sent.push({
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: new TextDecoder().decode(r.body ?? new Uint8Array()),
      });
      expect(r.readAuthErrorBodies).toBe(true);
      return answer(a);
    };
    return { sent, fetch };
  }

  it('joins the endpoint and path, and sends UCP-Agent, Request-Id and the Idempotency-Key', async () => {
    const s = restServer({ status: 201, body: { ucp: { version: '2026-08-25' }, id: 'cart_1' } });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    const r = await t.call({
      transport: 'rest',
      endpoint: `${REST}/`,
      profileUrl: PROFILE,
      operation: 'create_cart',
      payload: { line_items: [] },
      idempotencyKey: 'key-9',
    });
    expect(r).toMatchObject({ ok: true, value: { id: 'cart_1' } });
    const sent = s.sent[0] as Sent;
    expect([sent.method, sent.url]).toEqual(['POST', `${REST}/carts`]);
    expect(sent.headers).toMatchObject({
      'idempotency-key': 'key-9',
      'ucp-agent': `profile="${PROFILE}"`,
    });
    expect(sent.headers['request-id']).toMatch(/^id-/);
  });

  it('an error is read by its code, not its status (Shopify answers profile_unreachable with 422), with Retry-After', async () => {
    const s = restServer({
      status: 422,
      body: { code: 'PROFILE_UNREACHABLE', content: 'cannot fetch' },
      headers: { 'retry-after': '12' },
    });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    expect(
      await t.call({
        transport: 'rest',
        endpoint: REST,
        profileUrl: PROFILE,
        operation: 'get_cart',
        id: 'c 1',
      }),
    ).toEqual({
      ok: false,
      kind: 'transport',
      error: {
        status: 422,
        httpStatus: 422,
        code: 'profile_unreachable',
        content: 'cannot fetch',
        retryAfter: 12,
      },
    });
    expect((s.sent[0] as Sent).url).toBe(`${REST}/carts/c%201`);
  });

  it('a success body that is not JSON is malformed', async () => {
    const s = restServer({ status: 200, body: 'not json' });
    const t = new UcpTransport({ fetch: s.fetch, randomId: ids });
    expect(
      await t.call({
        transport: 'rest',
        endpoint: REST,
        profileUrl: PROFILE,
        operation: 'get_order',
        id: 'o1',
      }),
    ).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'body',
    });
  });
});
