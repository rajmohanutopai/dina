import { parseRetryAfter, readBusinessAnswer, readMcpError, readRestError } from '../src/errors';
import {
  INITIALIZED_NOTIFICATION,
  initializeRequest,
  messageFromSse,
  negotiatedProtocolVersion,
  readToolCallResponse,
  toolCallRequest,
} from '../src/mcp';
import { hasUnrecoverable, parseMessages, requiresHandoff } from '../src/messages';
import { isOperationName, OPERATIONS } from '../src/operations';
import { buildRestRequest, ucpAgentHeader } from '../src/rest';
import { dictGet, parseDictionary } from '../src/sf';

const PROFILE = 'https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/.well-known/ucp';

describe('operations', () => {
  it('has no complete_checkout: no code path can complete a checkout (S6)', () => {
    expect(isOperationName('complete_checkout')).toBe(false);
    expect(Object.keys(OPERATIONS)).not.toContain('complete_checkout');
    expect(Object.values(OPERATIONS).some((o) => o.path.endsWith('/complete'))).toBe(false);
  });
});

describe('REST binding', () => {
  it('UCP-Agent is an RFC 8941 dictionary with an sf-string profile', () => {
    const header = ucpAgentHeader(PROFILE);
    expect(header).toBe(`profile="${PROFILE}"`);
    expect(dictGet(parseDictionary(header), 'profile')).toMatchObject({
      value: { type: 'string', value: PROFILE },
    });
  });
  it('builds create_checkout with every header the OpenAPI marks required', () => {
    const r = buildRestRequest({
      endpoint: 'https://shop.example/ucp/',
      operation: 'create_checkout',
      profileUrl: PROFILE,
      requestId: 'r1',
      idempotencyKey: 'k1',
      body: '{"line_items":[]}',
    });
    expect(r).toEqual({
      method: 'POST',
      url: 'https://shop.example/ucp/checkout-sessions',
      headers: {
        'ucp-agent': `profile="${PROFILE}"`,
        'request-id': 'r1',
        accept: 'application/json',
        'idempotency-key': 'k1',
        'content-type': 'application/json',
      },
      body: '{"line_items":[]}',
    });
  });
  it('builds get_order with the id in the path, encoded, and no idempotency key or body', () => {
    const r = buildRestRequest({
      endpoint: 'https://shop.example/ucp',
      operation: 'get_order',
      id: 'gid://o/1',
      profileUrl: PROFILE,
      requestId: 'r',
    });
    expect(r.url).toBe('https://shop.example/ucp/orders/gid%3A%2F%2Fo%2F1');
    expect(r.headers['idempotency-key']).toBeUndefined();
    expect(r.body).toBeUndefined();
  });
  it('cancel carries a key and no body', () => {
    const r = buildRestRequest({
      endpoint: 'https://s.example',
      operation: 'cancel_checkout',
      id: 'c1',
      profileUrl: PROFILE,
      requestId: 'r',
      idempotencyKey: 'k',
    });
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://s.example/checkout-sessions/c1/cancel');
    expect(r.body).toBeUndefined();
  });
  it.each([
    ['missing id', { operation: 'get_cart' as const }, /needs an id/],
    ['stray id', { operation: 'search_catalog' as const, id: 'x', body: '{}' }, /takes no id/],
    ['missing key', { operation: 'create_cart' as const, body: '{}' }, /needs an idempotency key/],
    [
      'stray key',
      { operation: 'get_order' as const, id: 'o', idempotencyKey: 'k' },
      /takes no idempotency key/,
    ],
    ['missing body', { operation: 'search_catalog' as const }, /needs body/],
    ['stray body', { operation: 'get_cart' as const, id: 'c', body: '{}' }, /takes no body/],
  ])('refuses %s', (_n, extra, message) => {
    expect(() =>
      buildRestRequest({
        endpoint: 'https://s.example',
        profileUrl: PROFILE,
        requestId: 'r',
        ...extra,
      }),
    ).toThrow(message);
  });
  it('MCP refuses a stray idempotency key the same way', () => {
    expect(() =>
      toolCallRequest({
        rpcId: 1,
        operation: 'get_order',
        profileUrl: PROFILE,
        id: 'o',
        idempotencyKey: 'k',
      }),
    ).toThrow(/takes no idempotency key/);
  });
});

describe('MCP binding', () => {
  it('builds initialize and the initialized notification', () => {
    expect(initializeRequest(1, '0.1.0')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'dina-ucp', version: '0.1.0' },
      },
    });
    expect(INITIALIZED_NOTIFICATION).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(negotiatedProtocolVersion({ protocolVersion: '2025-06-18' })).toBe('2025-06-18');
    expect(negotiatedProtocolVersion({ protocolVersion: '1999-01-01' })).toBeNull();
  });
  it('builds tools/call with meta, id and the payload under its argument', () => {
    expect(
      toolCallRequest({
        rpcId: 7,
        operation: 'update_checkout',
        profileUrl: PROFILE,
        id: 'c1',
        idempotencyKey: 'k',
        payload: { line_items: [] },
      }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'update_checkout',
        arguments: {
          meta: { 'ucp-agent': { profile: PROFILE }, 'idempotency-key': 'k' },
          id: 'c1',
          checkout: { line_items: [] },
        },
      },
    });
  });
  it('refuses a cart or checkout payload that carries id (checkout/mcp.md:116-125)', () => {
    expect(() =>
      toolCallRequest({
        rpcId: 1,
        operation: 'create_cart',
        profileUrl: PROFILE,
        idempotencyKey: 'k',
        payload: { id: 'x', line_items: [] },
      }),
    ).toThrow(/must not carry id/);
  });
  it('get_product keeps the id inside the catalog payload', () => {
    const req = toolCallRequest({
      rpcId: 1,
      operation: 'get_product',
      profileUrl: PROFILE,
      payload: { id: 'p1' },
    });
    expect(req.params).toEqual({
      name: 'get_product',
      arguments: { meta: { 'ucp-agent': { profile: PROFILE } }, catalog: { id: 'p1' } },
    });
  });
  it('reads structuredContent, falls back to content[0].text, and reads errors', () => {
    expect(
      readToolCallResponse(
        { jsonrpc: '2.0', id: 3, result: { structuredContent: { ucp: { version: 'v' } } } },
        3,
      ),
    ).toEqual({
      kind: 'result',
      value: { ucp: { version: 'v' } },
    });
    expect(
      readToolCallResponse(
        { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"a":1}' }] } },
        3,
      ),
    ).toEqual({
      kind: 'result',
      value: { a: 1 },
    });
    expect(
      readToolCallResponse(
        {
          jsonrpc: '2.0',
          id: 3,
          error: {
            code: -32001,
            message: 'UCP discovery failed',
            data: { code: 'profile_unreachable' },
          },
        },
        3,
      ),
    ).toEqual({
      kind: 'rpc_error',
      code: -32001,
      message: 'UCP discovery failed',
      data: { code: 'profile_unreachable' },
    });
    expect(readToolCallResponse({ jsonrpc: '2.0', id: 4, result: {} }, 3)).toEqual({
      kind: 'malformed',
      reason: 'id_mismatch',
    });
    expect(readToolCallResponse({ jsonrpc: '2.0', id: 3, result: { isError: true } }, 3)).toEqual({
      kind: 'malformed',
      reason: 'no_structured_content',
    });
  });
  it('never relies on isError: a result with structuredContent is a result', () => {
    expect(
      readToolCallResponse(
        {
          jsonrpc: '2.0',
          id: 3,
          result: { isError: true, structuredContent: { ucp: { status: 'error' } } },
        },
        3,
      ),
    ).toEqual({ kind: 'result', value: { ucp: { status: 'error' } } });
  });
  it('picks the answering message out of an SSE body', () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0",\ndata: "id":5,"result":{}}\n\n';
    expect(messageFromSse(body, 5)).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
    expect(messageFromSse(body, 6)).toBeNull();
  });
});

describe('messages', () => {
  it('reads the three types, lower-cases codes, defaults presentation', () => {
    const p = parseMessages([
      {
        type: 'error',
        code: 'OUT_OF_STOCK',
        content: 'gone',
        severity: 'recoverable',
        path: '$.line_items[0]',
      },
      { type: 'warning', code: 'final_sale', content: 'no returns' },
      { type: 'info', content: 'free shipping', code: 'free_shipping' },
    ]);
    expect(p.unreadable).toBe(0);
    expect(p.messages[0]).toMatchObject({ code: 'out_of_stock', severity: 'recoverable' });
    expect(p.messages[1]).toMatchObject({ presentation: 'notice', contentType: 'plain' });
  });
  it('a message it cannot read means hand off', () => {
    const p = parseMessages([{ type: 'error', code: 'x', content: 'y', severity: 'catastrophic' }]);
    expect(p.unreadable).toBe(1);
    expect(requiresHandoff(p)).toBe(true);
  });
  it('requires hand-off on buyer input or review, and on a disclosure with an image', () => {
    for (const severity of ['requires_buyer_input', 'requires_buyer_review']) {
      expect(
        requiresHandoff(parseMessages([{ type: 'error', code: 'x', content: 'y', severity }])),
      ).toBe(true);
    }
    expect(
      requiresHandoff(
        parseMessages([{ type: 'error', code: 'x', content: 'y', severity: 'recoverable' }]),
      ),
    ).toBe(false);
    expect(
      requiresHandoff(
        parseMessages([
          {
            type: 'warning',
            code: 'prop65',
            content: 'warn',
            presentation: 'disclosure',
            image_url: 'https://i.example/w.png',
          },
        ]),
      ),
    ).toBe(true);
    expect(
      requiresHandoff(
        parseMessages([
          { type: 'warning', code: 'prop65', content: 'warn', presentation: 'disclosure' },
        ]),
      ),
    ).toBe(false);
    expect(
      hasUnrecoverable(
        parseMessages([
          { type: 'error', code: 'not_found', content: 'x', severity: 'unrecoverable' },
        ]),
      ),
    ).toBe(true);
  });
});

describe('errors', () => {
  it('tells a resource from an error_response', () => {
    expect(readBusinessAnswer({ ucp: { version: 'v' }, id: 'c1' }).kind).toBe('resource');
    const err = readBusinessAnswer({
      ucp: { version: 'v', status: 'error' },
      messages: [{ type: 'error', code: 'out_of_stock', content: 'x', severity: 'unrecoverable' }],
      continue_url: 'https://shop.example/cart',
    });
    expect(err).toMatchObject({ kind: 'error_response', continueUrl: 'https://shop.example/cart' });
    expect(readBusinessAnswer({ ucp: { version: 'v', status: 'error' } })).toEqual({
      kind: 'malformed',
      reason: 'error_without_messages',
    });
    expect(readBusinessAnswer({ id: 'x' })).toEqual({ kind: 'malformed', reason: 'no_ucp' });
  });
  it('reads a REST transport error by its code, not its status, and Retry-After', () => {
    expect(
      readRestError(
        422,
        { code: 'profile_unreachable', content: 'x', continue_url: 'https://s.example/' },
        '30',
      ),
    ).toEqual({
      status: 422,
      httpStatus: 422,
      code: 'profile_unreachable',
      content: 'x',
      continueUrl: 'https://s.example/',
      retryAfter: 30,
    });
  });
  it('reads version_unsupported in the error_response shape too (plan A4)', () => {
    expect(
      readRestError(422, {
        ucp: { status: 'error' },
        messages: [
          { type: 'error', code: 'version_unsupported', content: 'x', severity: 'unrecoverable' },
        ],
      }).code,
    ).toBe('version_unsupported');
  });
  it('reads an MCP error and its retry_after', () => {
    expect(readMcpError(-32000, { code: 'RATE_LIMITED', retry_after: 5 })).toEqual({
      status: -32000,
      code: 'rate_limited',
      retryAfter: 5,
    });
  });
  it('reads Retry-After seconds only', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
