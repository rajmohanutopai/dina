/**
 * Ephemeral runtime presence for authorized reasoning backends.
 *
 * A durable binding answers "may this principal reason for the owner?" It does
 * not prove the worker process currently exists. Auto-routing requires both.
 * Presence is deliberately process-local, short-lived, and never persisted as
 * owner policy.
 */

const DEFAULT_PRESENCE_TTL_MS = 10_000;

interface Presence {
  principalDid: string;
  seenAtMs: number;
}

const present = new Map<string, Presence>();

export function markReasoningBackendPresent(
  backendId: string,
  principalDid: string,
  nowMs: number = Date.now(),
): void {
  if (backendId === '' || principalDid === '' || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('invalid reasoning backend presence');
  }
  present.set(backendId, { principalDid, seenAtMs: nowMs });
}

export function clearReasoningBackendPresence(backendId: string, principalDid: string): void {
  const current = present.get(backendId);
  if (current?.principalDid === principalDid) present.delete(backendId);
}

export function isReasoningBackendPresent(
  backendId: string,
  principalDid: string,
  nowMs: number = Date.now(),
  ttlMs: number = DEFAULT_PRESENCE_TTL_MS,
): boolean {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error('invalid reasoning backend presence ttl');
  }
  const current = present.get(backendId);
  return (
    current !== undefined &&
    current.principalDid === principalDid &&
    current.seenAtMs <= nowMs &&
    nowMs - current.seenAtMs <= ttlMs
  );
}

export function resetReasoningBackendPresence(): void {
  present.clear();
}

export { DEFAULT_PRESENCE_TTL_MS };
