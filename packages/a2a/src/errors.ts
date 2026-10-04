/**
 * A2A error vocabulary and its JSON-RPC codes (spec §3.3.2, §5.4, §9.5).
 *
 * Error details ride `error.data` as ProtoJSON `Any` objects. Dina sends one
 * `google.rpc.ErrorInfo`, with a reason that is safe to show any caller:
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

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonObject[];
}

/**
 * An A2A error, with Dina's reason as one `ErrorInfo` when given. `metadata`
 * (ErrorInfo's string map) names what the caller needs to go on, such as
 * the task an unfinished wait is about; it never says why a skill was refused.
 */
export function a2aError(kind: A2AErrorKind, reason?: string, metadata?: Readonly<Record<string, string>>): JsonRpcErrorObject {
  const error: JsonRpcErrorObject = {
    code: JSONRPC_ERROR_CODES[kind],
    message: STANDARD_MESSAGES[kind],
  };
  if (reason !== undefined) {
    error.data = [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason,
        domain: DINA_ERROR_DOMAIN,
        ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
      },
    ];
  }
  return error;
}
