/**
 * Body limit middleware — reject oversized request bodies.
 *
 * Default limit: 2 MB (matches Express raw parser limit).
 * Returns a structured rejection for bodies exceeding the limit.
 *
 * Applied early in the middleware pipeline (before auth) to prevent
 * resource exhaustion from large payloads.
 *
 * Source: ARCHITECTURE.md Task 2.7
 */

import { MAX_BODY_SIZE_BYTES } from '../constants';

const DEFAULT_LIMIT_BYTES = MAX_BODY_SIZE_BYTES;

export interface BodyLimitResult {
  allowed: boolean;
  bodySize: number;
  limitBytes: number;
  reason?: string;
}

/** Configurable body limit. */
let limitBytes = DEFAULT_LIMIT_BYTES;

/**
 * Check if a request body is within the size limit.
 *
 * @param body — the request body (string or Uint8Array)
 * @returns BodyLimitResult with allowed=true or rejection details
 */
export function checkBodyLimit(body: string | Uint8Array | null | undefined): BodyLimitResult {
  const size = getBodySize(body);

  if (size <= limitBytes) {
    return { allowed: true, bodySize: size, limitBytes };
  }

  return {
    allowed: false,
    bodySize: size,
    limitBytes,
    reason: `Payload too large: ${formatSize(size)} exceeds limit of ${formatSize(limitBytes)}`,
  };
}

/**
 * Get the byte size of a body.
 */
export function getBodySize(body: string | Uint8Array | null | undefined): number {
  if (!body) return 0;
  if (body instanceof Uint8Array) return body.length;
  return new TextEncoder().encode(body).length;
}

/**
 * Set the body limit in bytes.
 */
export function setBodyLimit(bytes: number): void {
  limitBytes = Math.max(0, Math.floor(bytes));
}

/**
 * Get the current body limit in bytes.
 */
export function getBodyLimit(): number {
  return limitBytes;
}

/**
 * Reset to default limit (for testing).
 */
export function resetBodyLimit(): void {
  limitBytes = DEFAULT_LIMIT_BYTES;
}

/**
 * Format bytes as a human-readable string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
