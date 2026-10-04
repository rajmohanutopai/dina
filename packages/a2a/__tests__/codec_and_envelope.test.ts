import {
  A2A_PROTOCOL_VERSION,
  JSONRPC_ERROR_CODES,
  a2aError,
  base64Decode,
  base64Encode,
  base64urlDecode,
  base64urlDecodeUtf8,
  base64urlEncode,
  buildJsonRpcRequest,
  checkRequestedVersion,
  speaksA2AVersion,
  jsonRpcError,
  jsonRpcResult,
  parseExtensionsHeader,
  parseJsonRpcRequest,
  parseJsonRpcRequestText,
  parseJsonRpcResponse,
} from '../src';

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe('base64url (RFC 4648 §5, unpadded, strict)', () => {
  it.each([
    [bytes(), ''],
    [bytes(0xf8), '-A'],
    [bytes(0xfb, 0xff), '-_8'],
    [bytes(1, 2, 3), 'AQID'],
    [bytes(0, 0, 0, 0), 'AAAAAA'],
  ])('round-trips %p as %s', (input, text) => {
    expect(base64urlEncode(input)).toBe(text);
    expect(base64urlDecode(text)).toEqual(input);
  });

  it.each([
    ['padding', 'AQ=='],
    ['standard alphabet', 'a+b/'],
    ['impossible length', 'AAAAA'],
    ['non-zero trailing bits (1 byte)', 'AR'],
    ['non-zero trailing bits (2 bytes)', 'AAB'],
    ['whitespace', 'AQ ID'],
  ])('refuses %s', (_name, text) => {
    expect(base64urlDecode(text)).toBeNull();
  });

  it('refuses invalid UTF-8 when decoding text', () => {
    expect(base64urlDecodeUtf8(base64urlEncode(bytes(0xff, 0xfe)))).toBeNull();
  });
});

describe('base64 (RFC 4648 §4, padded, strict)', () => {
  it.each([
    [bytes(), ''],
    [bytes(0xfb, 0xff), '+/8='],
    [bytes(1), 'AQ=='],
    [bytes(1, 2, 3), 'AQID'],
  ])('round-trips %p as %s', (input, text) => {
    expect(base64Encode(input)).toBe(text);
    expect(base64Decode(text)).toEqual(input);
  });

  it.each([
    ['missing padding', 'AQ'],
    ['url alphabet', '-_8='],
    ['padding in the middle', 'AQ==AQ=='],
    ['three padding characters', 'A==='],
    ['non-zero trailing bits', 'AR=='],
  ])('refuses %s', (_name, text) => {
    expect(base64Decode(text)).toBeNull();
  });
});

describe('JSON-RPC 2.0 request envelope', () => {
  it('accepts a well-formed A2A request', () => {
    const parsed = parseJsonRpcRequestText(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id: 't1' } }),
    );
    expect(parsed).toEqual({
      ok: true,
      request: { id: 7, method: 'GetTask', params: { id: 't1' } },
    });
  });

  it('accepts a request with no params (GetExtendedAgentCard)', () => {
    const parsed = parseJsonRpcRequest({ jsonrpc: '2.0', id: 'x', method: 'GetExtendedAgentCard' });
    expect(parsed.ok && parsed.request.params).toEqual({});
  });

  it.each([
    ['bad JSON', '{', JSONRPC_ERROR_CODES.parseError],
    ['an array', '[]', JSONRPC_ERROR_CODES.invalidRequest],
    [
      'two method members (read last-wins by JSON.parse)',
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","method":"CancelTask"}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'a __proto__ member',
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"__proto__":{"a":1}}}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'a lone surrogate',
      '{"jsonrpc":"2.0","id":"\\ud800","method":"GetTask"}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'a null id',
      '{"jsonrpc":"2.0","id":null,"method":"GetTask"}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'a fractional id',
      '{"jsonrpc":"2.0","id":1.5,"method":"GetTask"}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'jsonrpc 1.0',
      '{"jsonrpc":"1.0","id":1,"method":"GetTask"}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'an unknown member',
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","x":1}',
      JSONRPC_ERROR_CODES.invalidRequest,
    ],
    [
      'an unknown method',
      '{"jsonrpc":"2.0","id":1,"method":"tasks/get"}',
      JSONRPC_ERROR_CODES.methodNotFound,
    ],
    [
      'array params',
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":[]}',
      JSONRPC_ERROR_CODES.invalidParams,
    ],
  ])('refuses %s', (_name, text, code) => {
    const parsed = parseJsonRpcRequestText(text);
    if (parsed.ok || 'notification' in parsed) throw new Error('expected an error reply');
    expect(parsed.error.code).toBe(code);
  });

  it('neither executes nor answers a notification (no id member; JSON-RPC 2.0 §4.1)', () => {
    expect(parseJsonRpcRequestText('{"jsonrpc":"2.0","method":"SendMessage","params":{}}')).toEqual(
      {
        ok: false,
        notification: true,
      },
    );
    // A valid notification for a method Dina does not have is still a notification (§4.1).
    expect(parseJsonRpcRequestText('{"jsonrpc":"2.0","method":"nope"}')).toEqual({
      ok: false,
      notification: true,
    });
  });

  it.each([
    ['the §7 example: method a number, params a string', '{"jsonrpc":"2.0","method":1,"params":"bar"}', 'method_required'],
    ['an empty object', '{}', 'jsonrpc_version'],
    ['jsonrpc 1.0', '{"jsonrpc":"1.0","method":"SendMessage"}', 'jsonrpc_version'],
    ['params a scalar', '{"jsonrpc":"2.0","method":"SendMessage","params":5}', 'params_not_structured'],
    ['an unknown member', '{"jsonrpc":"2.0","method":"SendMessage","foo":"boo"}', 'unknown_member'],
  ])('answers an id-less object that is not a valid Request (%s): -32600, id null (JSON-RPC 2.0 §5, §7)', (_name, text, reason) => {
    const parsed = parseJsonRpcRequestText(text);
    if (parsed.ok || 'notification' in parsed) throw new Error('expected an error reply');
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32600);
    expect(JSON.stringify(parsed.error)).toContain(reason);
  });

  it('echoes the id it could read on a refusal', () => {
    const parsed = parseJsonRpcRequest({ jsonrpc: '2.0', id: 'r1', method: 'nope' });
    expect(!parsed.ok && 'id' in parsed && parsed.id).toBe('r1');
  });

  it('builds results and errors with the A2A codes', () => {
    expect(jsonRpcResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(jsonRpcError(1, a2aError('taskNotFound'))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'Task not found' },
    });
    expect(a2aError('versionNotSupported', 'only_1_0').data).toEqual([
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'only_1_0',
        domain: 'dinakernel.com',
      },
    ]);
    expect(buildJsonRpcRequest('q', 'SendMessage', {})).toEqual({
      jsonrpc: '2.0',
      id: 'q',
      method: 'SendMessage',
      params: {},
    });
  });

  it('pins every A2A error code to spec §5.4', () => {
    expect(JSONRPC_ERROR_CODES).toEqual({
      parseError: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internalError: -32603,
      taskNotFound: -32001,
      taskNotCancelable: -32002,
      pushNotificationNotSupported: -32003,
      unsupportedOperation: -32004,
      contentTypeNotSupported: -32005,
      invalidAgentResponse: -32006,
      extendedAgentCardNotConfigured: -32007,
      extensionSupportRequired: -32008,
      versionNotSupported: -32009,
    });
  });
});

describe('JSON-RPC response parsing', () => {
  it('reads a result for the expected id', () => {
    expect(parseJsonRpcResponse({ jsonrpc: '2.0', id: 3, result: { a: 1 } }, 3)).toEqual({
      ok: true,
      result: { a: 1 },
    });
  });

  it('reads an error', () => {
    expect(
      parseJsonRpcResponse({ jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'x' } }, 3),
    ).toEqual({
      ok: false,
      error: { code: -32001, message: 'x' },
    });
  });

  // Cold audit C6-1
  it.each([
    [-32700, 'Parse error'],
    [-32600, 'Invalid Request'],
  ])('reads error %d sent with a null id, as JSON-RPC 2.0 §5 has a server that could not read the id answer', (code, message) => {
    expect(parseJsonRpcResponse({ jsonrpc: '2.0', id: null, error: { code, message } }, 3)).toEqual({ ok: false, error: { code, message } });
  });

  it.each([
    ['another id', { jsonrpc: '2.0', id: 4, result: {} }, 'id_mismatch'],
    // A null id comes only with the two errors a server sends when it could not read the id (§5).
    ['a result with a null id', { jsonrpc: '2.0', id: null, result: {} }, 'id_mismatch'],
    ['another error with a null id', { jsonrpc: '2.0', id: null, error: { code: -32602, message: 'x' } }, 'id_mismatch'],
    ['an A2A error with a null id', { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'x' } }, 'id_mismatch'],
    ['both result and error', { jsonrpc: '2.0', id: 3, result: {}, error: {} }, 'result_xor_error'],
    ['neither', { jsonrpc: '2.0', id: 3 }, 'result_xor_error'],
    ['a bad error object', { jsonrpc: '2.0', id: 3, error: { code: 'x' } }, 'error_shape'],
    ['no jsonrpc', { id: 3, result: {} }, 'jsonrpc_version'],
  ])('refuses %s', (_name, value, malformed) => {
    expect(parseJsonRpcResponse(value, 3)).toEqual({ ok: false, malformed });
  });
});

describe('A2A service parameters', () => {
  it.each([
    ['1.0', true],
    [' 1.0 ', true],
    // Negotiation matches Major.Minor; a patch SHOULD NOT be sent and is ignored (spec §3.6).
    ['1.0.1', true],
    ['1.00', false],
    ['01.0', false],
    ['1.0.01', false],
    ['', false],
    [undefined, false],
    ['0.3', false],
    ['2.0', false],
    ['v1.0', false],
  ])('A2A-Version %p accepted: %p', (header, ok) => {
    expect(checkRequestedVersion(header).ok).toBe(ok);
    // One grammar on every door: Core's ingress asks speaksA2AVersion.
    if (header !== undefined) expect(speaksA2AVersion(header)).toBe(ok);
  });

  it('reads the request parameter when the header is absent, and prefers the header', () => {
    expect(checkRequestedVersion(undefined, '1.0').ok).toBe(true);
    expect(checkRequestedVersion(null, '0.3')).toEqual({ ok: false, requested: '0.3' });
    expect(checkRequestedVersion('1.0', '0.3').ok).toBe(true);
    expect(checkRequestedVersion(undefined, undefined)).toEqual({ ok: false, requested: '0.3' });
  });

  it('reads an empty version as 0.3 (spec §3.6.2)', () => {
    expect(checkRequestedVersion('')).toEqual({ ok: false, requested: '0.3' });
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
  });

  it('parses A2A-Extensions as a de-duplicated list', () => {
    expect(parseExtensionsHeader(' https://a/v1, ,https://b/v1,https://a/v1 ')).toEqual([
      'https://a/v1',
      'https://b/v1',
    ]);
    expect(parseExtensionsHeader(undefined)).toEqual([]);
  });
});
