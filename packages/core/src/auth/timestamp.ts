/**
 * RFC3339 timestamp validation for request auth.
 *
 * Timestamps must be within a 5-minute window of the current time.
 * This prevents replay attacks while tolerating clock skew.
 *
 * Source: core/internal/middleware/auth.go (timestamp validation)
 */

import { TIMESTAMP_WINDOW_S } from '../constants';
/** Maximum allowed timestamp drift in seconds (5 minutes). */
export const TIMESTAMP_WINDOW_SECONDS = TIMESTAMP_WINDOW_S;

// RFC3339 pattern: YYYY-MM-DDTHH:MM:SS followed by Z or ±HH:MM
const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate an RFC3339 timestamp is within the allowed window.
 *
 * @param timestamp - RFC3339 string (e.g., "2026-04-09T12:00:00Z")
 * @param now - Current time (injectable for testing)
 * @returns true if timestamp is within ±TIMESTAMP_WINDOW_SECONDS of now
 * @throws if timestamp is not valid RFC3339
 */
export function isTimestampValid(timestamp: string, now?: Date): boolean {
  const ts = parseRFC3339(timestamp);
  const currentTime = now || new Date();
  const diffMs = Math.abs(currentTime.getTime() - ts.getTime());
  return diffMs <= TIMESTAMP_WINDOW_SECONDS * 1000;
}

/**
 * Parse an RFC3339 timestamp to a Date.
 * @throws if the string is not valid RFC3339
 */
export function parseRFC3339(timestamp: string): Date {
  if (!timestamp || timestamp.length === 0) {
    throw new Error('timestamp: empty string');
  }
  if (!RFC3339_REGEX.test(timestamp)) {
    throw new Error(`timestamp: invalid RFC3339 format — "${timestamp}"`);
  }
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    throw new Error(`timestamp: unparseable RFC3339 — "${timestamp}"`);
  }
  return date;
}

/**
 * Format a Date as an RFC3339 string (UTC, 'Z' suffix).
 */
export function toRFC3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
