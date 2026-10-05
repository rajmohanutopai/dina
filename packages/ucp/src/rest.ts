/**
 * The REST binding (rest.openapi.json; overview :1010-1040): the endpoint from
 * the merchant's profile joined with the OpenAPI path; headers `UCP-Agent`
 * (RFC 8941 dictionary), `Request-Id` (every operation) and `Idempotency-Key`
 * (every state change). The OpenAPI marks all three required where the prose
 * says SHOULD (plan A2); Dina always sends them.
 */

import { OPERATIONS, type OperationName } from './operations';
import { serializeDictionary, sfString } from './sf';

/** `UCP-Agent: profile="<url>"`. */
export function ucpAgentHeader(profileUrl: string): string {
  return serializeDictionary([['profile', sfString(profileUrl)]]);
}

export interface RestRequestInput {
  endpoint: string;
  operation: OperationName;
  /** The resource id for operations that take one. */
  id?: string;
  profileUrl: string;
  requestId: string;
  /** Required when the operation changes state. */
  idempotencyKey?: string;
  /** The payload for operations that carry one; serialized by the caller into exact bytes. */
  body?: string;
}

export interface RestRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  body?: string;
}

export function buildRestRequest(input: RestRequestInput): RestRequest {
  const op = OPERATIONS[input.operation];
  if (op.takesId && (input.id === undefined || input.id === ''))
    throw new Error(`rest: ${input.operation} needs an id`);
  if (!op.takesId && input.id !== undefined)
    throw new Error(`rest: ${input.operation} takes no id`);
  if (op.mutating && input.idempotencyKey === undefined)
    throw new Error(`rest: ${input.operation} needs an idempotency key`);
  if (!op.mutating && input.idempotencyKey !== undefined)
    throw new Error(`rest: ${input.operation} takes no idempotency key`);
  if ((op.payloadArg !== undefined) !== (input.body !== undefined)) {
    throw new Error(
      `rest: ${input.operation} ${op.payloadArg !== undefined ? 'needs' : 'takes no'} body`,
    );
  }
  const path = op.path.replace('{id}', encodeURIComponent(input.id ?? ''));
  const headers: Record<string, string> = {
    'ucp-agent': ucpAgentHeader(input.profileUrl),
    'request-id': input.requestId,
    accept: 'application/json',
  };
  if (op.mutating) headers['idempotency-key'] = input.idempotencyKey as string;
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  return {
    method: op.method,
    url: `${input.endpoint.replace(/\/$/, '')}${path}`,
    headers,
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
}
