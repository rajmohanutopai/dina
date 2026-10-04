/** Fresh A2A identifiers: RFC 9562 v4 UUIDs (design A2A-I5). */

import { randomBytes } from '@noble/hashes/utils.js';

import { uuidV4FromBytes } from '@dina/a2a';

export function newA2AId(): string {
  return uuidV4FromBytes(randomBytes(16));
}

/**
 * Workflow task ids and idempotency keys under this prefix are Core's alone:
 * the A2A path names its consent card and dispatch child with them, and a
 * task squatting one (Brain learns the operation id) would block the owner's
 * approved send. The workflow route refuses both.
 */
export const A2A_TASK_NAMESPACE = 'a2a-';

export function isA2ATaskNamespace(value: string | undefined): boolean {
  return value !== undefined && value.startsWith(A2A_TASK_NAMESPACE);
}

export const a2aConsentTaskId = (operationId: string): string => `${A2A_TASK_NAMESPACE}consent-${operationId}`;
export const a2aConsentKey = (operationId: string): string => `${A2A_TASK_NAMESPACE}consent:${operationId}`;
export const a2aDispatchTaskId = (): string => `${A2A_TASK_NAMESPACE}dispatch-${newA2AId()}`;
export const a2aDispatchKey = (operationId: string): string => `${A2A_TASK_NAMESPACE}dispatch:${operationId}`;
