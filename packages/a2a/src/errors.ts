/**
 * A2A error vocabulary and its JSON-RPC codes (spec §3.3.2, §5.4, §9.5).
 *
 * Error details ride `error.data` as ProtoJSON `Any` objects. Every error
 * leads with A2A's own `google.rpc.ErrorInfo` (its reason in UPPER_SNAKE_CASE,
 * domain `a2a-protocol.org`), as spec §9.5 requires of A2A errors and the
 * reference SDK sends for all of them; Dina's reason, when it gives one,
 * follows in Dina's domain. Dina's reason is safe to show any caller:
 * refusals collapse to one shape (design A2A-I4), so a detail never says WHY
 * a skill was refused, only THAT it was.
 */

import type { JsonObject } from './json';

export const JSONRPC_ERROR_CODES = Object.freeze({
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
} as const);

export type A2AErrorKind = keyof typeof JSONRPC_ERROR_CODES;

const STANDARD_MESSAGES: Readonly<Record<A2AErrorKind, string>> = Object.freeze({
  parseError: 'Invalid JSON payload',
  invalidRequest: 'Request payload validation error',
  methodNotFound: 'Method not found',
  invalidParams: 'Invalid parameters',
  internalError: 'Internal error',
  taskNotFound: 'Task not found',
  taskNotCancelable: 'Task cannot be canceled',
  pushNotificationNotSupported: 'Push notifications are not supported',
  unsupportedOperation: 'Operation not supported',
  contentTypeNotSupported: 'Content type not supported',
  invalidAgentResponse: 'Invalid agent response',
  extendedAgentCardNotConfigured: 'Extended agent card is not configured',
  extensionSupportRequired: 'A required extension was not declared',
  versionNotSupported: 'A2A version not supported',
});

/** `ErrorInfo.domain` for reasons Dina defines. */
export const DINA_ERROR_DOMAIN = 'dinakernel.com';

/** `google.rpc.ErrorInfo.domain` for A2A's own reasons (as the reference SDK sends them). */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/** A2A's reason for each error code (spec §9.5, §11.6; the reference SDK's table). */
export const A2A_ERROR_REASONS: Readonly<Record<number, string>> = Object.freeze({
  [-32001]: 'TASK_NOT_FOUND',
  [-32002]: 'TASK_NOT_CANCELABLE',
  [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  [-32004]: 'UNSUPPORTED_OPERATION',
  [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
  [-32006]: 'INVALID_AGENT_RESPONSE',
  [-32007]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
  [-32008]: 'EXTENSION_SUPPORT_REQUIRED',
  [-32009]: 'VERSION_NOT_SUPPORTED',
  [-32700]: 'INVALID_REQUEST',
  [-32600]: 'INVALID_REQUEST',
  [-32601]: 'METHOD_NOT_FOUND',
  [-32602]: 'INVALID_PARAMS',
  [-32603]: 'INTERNAL_ERROR',
});

/** A2A's own `ErrorInfo` for an error code. */
export function a2aErrorInfo(code: number): JsonObject {
  return { '@type': ERROR_INFO_TYPE, reason: A2A_ERROR_REASONS[code] ?? 'INTERNAL_ERROR', domain: A2A_ERROR_DOMAIN, metadata: {} };
}

/**
 * The JSON-RPC code of a refusal that is Dina's, not A2A's: no credential, a
 * rate limit, a body over the cap. JSON-RPC 2.0 keeps -32000 to -32099 for
 * server errors and A2A's own start at -32001, so these take -32000. Spec
 * §3.3.2 asks a JSON-RPC server to answer an authentication failure with such
 * a custom error.
 */
export const DINA_REFUSAL_CODE = -32000;

const REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  unauthenticated: 'Unauthenticated',
  rate_limited: 'Rate limited',
  too_many_streams: 'Too many open streams',
  payload_too_large: 'Request body too large',
  unsupported_media_type: 'Unsupported content type',
  unavailable: 'Service unavailable',
});

/** Dina's own refusal as a JSON-RPC error: code -32000, Dina's reason in its details. */
export function dinaRefusal(reason: string): JsonRpcErrorObject {
  return {
    code: DINA_REFUSAL_CODE,
    message: REFUSAL_MESSAGES[reason] ?? 'Request refused',
    data: [{ '@type': ERROR_INFO_TYPE, reason, domain: DINA_ERROR_DOMAIN }],
  };
}

/** Dina's own `ErrorInfo` in an error's details (its reason, in Dina's domain), when it carries one. */
export function dinaErrorInfo(error: { data?: readonly JsonObject[] }): JsonObject | undefined {
  return error.data?.find((d) => d['@type'] === ERROR_INFO_TYPE && d.domain === DINA_ERROR_DOMAIN);
}

/** Whether `detail` is A2A's own `ErrorInfo`. */
export function isA2AErrorInfo(detail: JsonObject | undefined): boolean {
  return detail !== undefined && detail['@type'] === ERROR_INFO_TYPE && detail.domain === A2A_ERROR_DOMAIN;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonObject[];
}

/**
 * An A2A error: A2A's own `ErrorInfo` first, then Dina's reason as a second
 * one when given. `metadata` (ErrorInfo's string map) names what the caller
 * needs to go on, such as the task an unfinished wait is about; it never
 * says why a skill was refused.
 */
export function a2aError(kind: A2AErrorKind, reason?: string, metadata?: Readonly<Record<string, string>>): JsonRpcErrorObject {
  const code = JSONRPC_ERROR_CODES[kind];
  return {
    code,
    message: STANDARD_MESSAGES[kind],
    data: [
      a2aErrorInfo(code),
      ...(reason === undefined
        ? []
        : [{ '@type': ERROR_INFO_TYPE, reason, domain: DINA_ERROR_DOMAIN, ...(metadata === undefined ? {} : { metadata: { ...metadata } }) }]),
    ],
  };
}
