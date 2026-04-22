/**
 * Resilience — graceful degradation when components unavailable.
 *
 * LLM unavailable → FTS-only queries (no reasoning).
 * Core unreachable → retry with exponential backoff, fail-closed.
 * Memory pressure → report heap usage for monitoring.
 * Invalid DID → reject gracefully without crash.
 *
 * Source: brain/tests/test_resilience.py
 */

/** Memory health threshold: 512 MB heap usage considered unhealthy. */
const HEAP_THRESHOLD_MB = 512;

/** Known fallback actions for common error types. */
const FALLBACK_MAP: Record<string, string> = {
  'LLM timeout': 'Use FTS-only search (no reasoning)',
  'LLM unavailable': 'Use FTS-only search (no reasoning)',
  'Core unreachable': 'Retry with exponential backoff',
  'embedding failed': 'Skip embedding, store without vector',
};

/**
 * Handle an unhandled exception gracefully (no crash).
 * Returns recovery status and optional fallback action.
 */
export function handleUnhandledException(error: Error): { recovered: boolean; fallback?: string } {
  // Try to find a known fallback for this error type
  for (const [keyword, fallback] of Object.entries(FALLBACK_MAP)) {
    if (error.message.toLowerCase().includes(keyword.toLowerCase())) {
      return { recovered: true, fallback };
    }
  }

  // Generic recovery: log and continue (don't crash the guardian loop)
  return { recovered: true, fallback: 'Continue with degraded functionality' };
}

/**
 * Check for memory leak indicators.
 * Uses process.memoryUsage() to report heap consumption.
 */
export function checkMemoryHealth(): { healthy: boolean; heapUsedMB: number } {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / (1024 * 1024));
  return {
    healthy: heapUsedMB < HEAP_THRESHOLD_MB,
    heapUsedMB,
  };
}

/**
 * Graceful shutdown — drain pending work before exit.
 * In production: waits for in-flight staging claims, checkpoints scratchpad.
 */
export async function gracefulShutdown(): Promise<void> {
  // TODO: Phase 3+ — drain staging processor, checkpoint scratchpad
  // For now: immediate clean shutdown
}

/**
 * Check startup dependencies (Core reachable, service keys loaded).
 * In production: HTTP health check to Core, verify PEM files exist.
 */
export async function checkStartupDependencies(): Promise<{ ready: boolean; missing: string[] }> {
  // TODO: Phase 3.2 — actual HTTP health check to Core
  // For now: assume dependencies are met (stub for testing)
  return { ready: true, missing: [] };
}

/**
 * Validate that a DID format is correct (no crash on invalid input).
 */
export function handleInvalidDID(did: string): { valid: boolean; error?: string } {
  if (!did || did.length === 0) {
    return { valid: false, error: 'DID is empty' };
  }

  // did:key: or did:plc: are the valid formats
  if (!did.startsWith('did:')) {
    return { valid: false, error: `Invalid DID format: must start with "did:", got "${did}"` };
  }

  const parts = did.split(':');
  if (parts.length < 3) {
    return {
      valid: false,
      error: `Invalid DID format: must have at least 3 colon-separated parts`,
    };
  }

  const method = parts[1];
  if (!['key', 'plc', 'web'].includes(method)) {
    return { valid: false, error: `Unknown DID method: "${method}"` };
  }

  return { valid: true };
}
