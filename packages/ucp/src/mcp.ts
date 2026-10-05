/**
 * The MCP binding (mcp.openrpc.json; transports/mcp_tool_call.json;
 * checkout/mcp.md): JSON-RPC 2.0 over Streamable HTTP. A UCP operation is a
 * `tools/call` whose `arguments` hold `meta` (`ucp-agent.profile`, and for a
 * state change `idempotency-key`), `id` for a named resource, and the payload
 * under `catalog`, `cart` or `checkout`. The payload never carries `id`
 * (checkout/mcp.md:116-125).
 *
 * The MCP lifecycle (UCP plan §3.6 step 5a; MCP 2025-11-25): `initialize`,
 * then `notifications/initialized`, then every later request carries
 * `MCP-Protocol-Version` and the session id if one was given.
 */

import { isPlainObject, parseStrictJson, type JsonObject, type JsonValue } from '@dina/a2a';

import { OPERATIONS, type OperationName } from './operations';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: JsonObject;
}

export function initializeRequest(id: string | number, clientVersion: string): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: 'dina-ucp', version: clientVersion },
    },
  };
}

export const INITIALIZED_NOTIFICATION = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
} as const;

/** The protocol version the server chose, if it is one Dina speaks. */
export function negotiatedProtocolVersion(result: unknown): string | null {
  if (!isPlainObject(result) || typeof result.protocolVersion !== 'string') return null;
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)
    ? result.protocolVersion
    : null;
}

export interface ToolCallInput {
  rpcId: string | number;
  operation: OperationName;
  profileUrl: string;
  id?: string;
  idempotencyKey?: string;
  payload?: JsonObject;
}

export function toolCallRequest(input: ToolCallInput): JsonRpcRequest {
  const op = OPERATIONS[input.operation];
  if (op.takesId && (input.id === undefined || input.id === ''))
    throw new Error(`mcp: ${input.operation} needs an id`);
  if (!op.takesId && input.id !== undefined) throw new Error(`mcp: ${input.operation} takes no id`);
  if (op.mutating && input.idempotencyKey === undefined)
    throw new Error(`mcp: ${input.operation} needs an idempotency key`);
  if (!op.mutating && input.idempotencyKey !== undefined)
    throw new Error(`mcp: ${input.operation} takes no idempotency key`);
  if ((op.payloadArg !== undefined) !== (input.payload !== undefined)) {
    throw new Error(
      `mcp: ${input.operation} ${op.payloadArg !== undefined ? 'needs' : 'takes no'} payload`,
    );
  }
  if (input.payload !== undefined && 'id' in input.payload && op.payloadArg !== 'catalog') {
    throw new Error(`mcp: the ${op.payloadArg} payload must not carry id`);
  }
  const meta: JsonObject = { 'ucp-agent': { profile: input.profileUrl } };
  if (op.mutating) meta['idempotency-key'] = input.idempotencyKey as string;
  const args: JsonObject = { meta };
  if (input.id !== undefined) args.id = input.id;
  if (op.payloadArg !== undefined) args[op.payloadArg] = input.payload as JsonObject;
  return {
    jsonrpc: '2.0',
    id: input.rpcId,
    method: 'tools/call',
    params: { name: input.operation, arguments: args },
  };
}

export type ToolCallResult =
  | { kind: 'result'; value: JsonObject }
  | { kind: 'rpc_error'; code: number; message: string; data?: JsonValue }
  | { kind: 'malformed'; reason: string };

/**
 * Read a JSON-RPC answer to `tools/call`: the UCP payload is
 * `result.structuredContent` (MUST), with `content[0].text` as a fallback
 * (overview :3006-3039). `isError` is never relied on.
 */
export function readToolCallResponse(message: unknown, rpcId: string | number): ToolCallResult {
  if (!isPlainObject(message) || message.jsonrpc !== '2.0')
    return { kind: 'malformed', reason: 'not_jsonrpc' };
  if (message.id !== rpcId) return { kind: 'malformed', reason: 'id_mismatch' };
  if (isPlainObject(message.error)) {
    const { code, message: text, data } = message.error;
    if (typeof code !== 'number' || typeof text !== 'string')
      return { kind: 'malformed', reason: 'bad_error' };
    return {
      kind: 'rpc_error',
      code,
      message: text,
      ...(data !== undefined ? { data: data as JsonValue } : {}),
    };
  }
  const result = message.result;
  if (!isPlainObject(result)) return { kind: 'malformed', reason: 'no_result' };
  if (isPlainObject(result.structuredContent))
    return { kind: 'result', value: result.structuredContent as JsonObject };
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (isPlainObject(first) && first.type === 'text' && typeof first.text === 'string') {
    // Merchant-written JSON in a string: parsed as strictly as any body Core reads
    // (no duplicate members, no `__proto__`, numbers in range), never JSON.parse.
    const parsed = parseStrictJson(first.text);
    if (!parsed.ok) return { kind: 'malformed', reason: `text_${parsed.reason}` };
    if (isPlainObject(parsed.value)) return { kind: 'result', value: parsed.value as JsonObject };
  }
  return { kind: 'malformed', reason: 'no_structured_content' };
}

/**
 * The JSON-RPC message for `rpcId` inside a `text/event-stream` body: each
 * event's `data:` lines joined, parsed strictly, and the one answering `rpcId`
 * returned. An event that is not strict JSON is skipped.
 */
export function messageFromSse(body: string, rpcId: string | number): unknown {
  const events = body.replace(/\r\n/g, '\n').split('\n\n');
  for (const event of events) {
    const data = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    const parsed = parseStrictJson(data);
    if (parsed.ok && isPlainObject(parsed.value) && parsed.value.id === rpcId) return parsed.value;
  }
  return null;
}
