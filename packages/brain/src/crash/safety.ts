/**
 * Crash traceback safety — never log PII, sanitize errors.
 *
 * Crash handler: catch-all wraps guardian loop and other async pipelines.
 * Stdout sanitized to one-liner (no stack traces in production logs).
 * Full traceback stored in vault crash_log (encrypted at rest).
 * Tracebacks never written to files outside vault.
 *
 * Source: brain/tests/test_crash.py
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { detectPII } from '../../../core/src/pii/patterns';

export interface CrashReport {
  component: string;
  message: string;
  stackHash: string;
  sanitizedOneLiner: string;
}

/** PII patterns to strip from stdout. */
const PII_STRIP_PATTERNS = [
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  /(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

/**
 * Wrap a function with crash-safe error handling.
 * On success: returns the function's result.
 * On error: builds crash report, re-throws with sanitized message.
 */
export async function withCrashHandler<T>(fn: () => Promise<T>, component: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const report = buildCrashReport(err, component);
    const wrapped = new Error(report.sanitizedOneLiner);
    Object.defineProperty(wrapped, 'crashReport', { value: report, enumerable: true });
    throw wrapped;
  }
}

/**
 * Sanitize a traceback for stdout (one-liner, no PII).
 * Includes error type/name. Max 200 characters.
 */
export function sanitizeForStdout(error: Error): string {
  let msg = `${error.name}: ${error.message}`;
  msg = msg.replace(/[\r\n]+/g, ' ').trim();

  for (const pattern of PII_STRIP_PATTERNS) {
    pattern.lastIndex = 0;
    msg = msg.replace(pattern, '[REDACTED]');
  }

  if (msg.length > 200) {
    msg = msg.slice(0, 197) + '...';
  }
  return msg;
}

/**
 * Build a crash report for vault storage.
 */
export function buildCrashReport(error: Error, component: string): CrashReport {
  const stackStr = error.stack ?? error.message;
  const stackHash = bytesToHex(sha256(new TextEncoder().encode(stackStr)));

  return {
    component,
    message: error.message,
    stackHash,
    sanitizedOneLiner: sanitizeForStdout(error),
  };
}

/**
 * Check that a crash log entry contains no PII.
 */
export function auditCrashLogForPII(entry: CrashReport): { clean: boolean; piiFound?: string[] } {
  const textToScan = [entry.message, entry.sanitizedOneLiner, entry.component].join(' ');
  const matches = detectPII(textToScan);

  if (matches.length === 0) {
    return { clean: true };
  }

  const piiTypes = [...new Set(matches.map((m) => m.type))];
  return { clean: false, piiFound: piiTypes };
}
