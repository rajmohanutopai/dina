/**
 * Composable `D2DScanner`s.
 *
 * A scanner is any function matching the `D2DScanner` contract from
 * `d2d_dispatcher`. This module provides:
 *
 *   - `composeScanners(...s)`: run a pipeline of scanners in order. First
 *     `dropped` wins; each allow-scanner's transformed body is handed to
 *     the next stage.
 *   - `createBodySizeScanner(maxBytes)`: reject messages whose JSON-encoded
 *     body exceeds the limit.
 *   - `createAllowListScanner({allowed})`: reject messages whose type is not
 *     on the caller-supplied allowlist (defence-in-depth alongside the
 *     dispatcher's own registration-based routing).
 *
 * Heavier checks (PII Tier-1 scrub, action-risk policy) are out of scope
 * for this module; they can be added as additional scanners that compose
 * cleanly with these.
 */

import type { D2DBody, D2DScanner, ScanResult } from './d2d_dispatcher';
import type { DinaMessage } from '@dina/test-harness';

/**
 * Compose multiple scanners into one. Runs them in order. If any scanner
 * drops the message, the pipeline stops and returns the drop reason from
 * that scanner. Otherwise the final allow-scanner's body is returned.
 *
 * Edge cases:
 *   - Zero scanners: returns a passthrough that echoes the input body.
 *   - One scanner: returned as-is (no wrapper overhead).
 */
export function composeScanners(...scanners: D2DScanner[]): D2DScanner {
  if (scanners.length === 0) {
    return (_type, body) => ({ body });
  }
  if (scanners.length === 1) {
    return scanners[0];
  }
  return (messageType: string, body: D2DBody, raw: DinaMessage): ScanResult => {
    let current = body;
    for (const s of scanners) {
      const result = s(messageType, current, raw);
      if (result.dropped === true) {
        return { body: current, dropped: true, reason: result.reason };
      }
      current = result.body;
    }
    return { body: current };
  };
}

// ---------------------------------------------------------------------------
// Concrete scanners
// ---------------------------------------------------------------------------

/**
 * Drop messages whose body JSON-serialises to more than `maxBytes`. Useful
 * as a defence-in-depth layer in addition to the wire-level 256 KB limit
 * already enforced in Core.
 *
 * Serialisation is `JSON.stringify` with UTF-8 byte length. The scan does
 * NOT mutate the body.
 */
export function createBodySizeScanner(maxBytes: number): D2DScanner {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`createBodySizeScanner: maxBytes must be > 0 (got ${maxBytes})`);
  }
  return (_type, body) => {
    const size = byteLength(JSON.stringify(body));
    if (size > maxBytes) {
      return {
        body,
        dropped: true,
        reason: `body exceeds max size ${maxBytes} bytes (got ${size})`,
      };
    }
    return { body };
  };
}

/**
 * Drop any message whose type is not on the allowlist. Complements the
 * dispatcher's registration surface: a forgotten `register()` call becomes
 * an explicit drop rather than a silent "no handler" response.
 */
export function createAllowListScanner(config: { allowed: readonly string[] }): D2DScanner {
  const allowed = new Set(config.allowed);
  return (messageType, body) => {
    if (!allowed.has(messageType)) {
      return {
        body,
        dropped: true,
        reason: `message type "${messageType}" is not on the allowlist`,
      };
    }
    return { body };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length of a string, matching the wire serialisation. Uses
 * `TextEncoder` when available (browsers + modern Node) and falls back to
 * `Buffer.byteLength` for older runtimes.
 */
function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  // Node-only path — Buffer is global in Node, absent in browsers but the
  // TextEncoder branch above will be taken there.
  return Buffer.byteLength(s, 'utf8');
}
