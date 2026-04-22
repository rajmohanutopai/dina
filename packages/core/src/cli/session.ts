/**
 * CLI session management — PII entity save/load, rehydration.
 *
 * Session ID format: "pii_" + 8 hex chars.
 * In-memory store for PII scrub/rehydrate cycles.
 *
 * Source: cli/tests/test_session.py
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface PIISessionData {
  entities: Array<{ token: string; type: string; value: string }>;
}

const sessions = new Map<string, PIISessionData>();

/** Generate a new session ID. Format: "pii_" + 8 hex chars. */
export function newSessionId(): string {
  return `pii_${bytesToHex(randomBytes(4))}`;
}

/** Save PII entities to a session. */
export function saveSession(sessionId: string, data: PIISessionData): void {
  sessions.set(sessionId, {
    entities: data.entities.map((e) => ({
      token: e.token,
      type: e.type.toUpperCase(),
      value: e.value,
    })),
  });
}

/** Load PII entities from a session. */
export function loadSession(sessionId: string): PIISessionData {
  const data = sessions.get(sessionId);
  if (!data) throw new Error(`cli_session: session "${sessionId}" not found`);
  return data;
}

/** Rehydrate scrubbed text using session-stored PII entities. */
export function rehydrateFromSession(scrubbed: string, sessionId: string): string {
  const data = loadSession(sessionId);
  let result = scrubbed;
  for (const entity of data.entities) {
    result = result.replace(entity.token, entity.value);
  }
  return result;
}

/** Clear all sessions (for testing). */
export function clearSessions(): void {
  sessions.clear();
}
