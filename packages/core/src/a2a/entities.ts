/**
 * Originals behind placeholders (A2A design A2A-I9, §6.5 "rehydration").
 *
 * A released answer may quote a placeholder back (`[EMAIL_1]`). The owner
 * sees what it stands for — but only on an owner surface, only for a
 * placeholder whose original Core kept (a single provable source), only
 * after the guard released the answer, and only while the source persona is
 * open. Core never writes an original INTO the remote's text: the remote
 * chose where its placeholders sit (inside a link, say), and the guard
 * judged the text with placeholders in it. The owner gets a legend beside
 * the answer instead. Brain's view carries no originals at all.
 *
 * A vault original is sealed under a key derived from its persona's DEK for
 * this purpose alone, bound to its operation and placeholder; a locked
 * persona leaves it shut, and a shredded one takes it with it. Originals go
 * 7 days after their operation ends, and in any case after 30 days (§9).
 */

import { openForPersonaPurpose } from '../persona/orchestrator';

import type { A2ARuntime } from './runtime';
import type { EntityRow } from './store';

export const ENTITY_RETENTION_AFTER_END_MS = 7 * 24 * 60 * 60_000;
/** The hard end of an original, whatever becomes of its operation. */
export const ENTITY_MAX_LIFE_MS = 30 * 24 * 60 * 60_000;
/** The HKDF purpose a vault original's key is derived for. */
export const ENTITY_SEAL_PURPOSE = 'dina:a2a:entities:v1';

/** What binds a sealed original to its place: a blob moved elsewhere does not open. */
export function entityAad(operationId: string, placeholder: string): Uint8Array {
  return new TextEncoder().encode(`${ENTITY_SEAL_PURPOSE}|${operationId}|${placeholder}`);
}

/** The original behind one entity row, or null when its persona is locked or the seal does not open. */
function unseal(row: EntityRow, operationId: string): string | null {
  if (row.seal === 'identity_db') return new TextDecoder().decode(row.sealed);
  if (row.persona === null) return null;
  try {
    const plain = openForPersonaPurpose(row.persona, ENTITY_SEAL_PURPOSE, entityAad(operationId, row.placeholder), row.sealed);
    return plain === null ? null : new TextDecoder().decode(plain);
  } catch {
    return null; // a wrong key, a moved blob or damage shows no original, never an error
  }
}

export interface PlaceholderLegendEntry {
  placeholder: string;
  original: string;
}

/**
 * For the owner's own surfaces only: what each placeholder in an operation's
 * message stands for, where Core kept the original and can open it now.
 */
export function placeholderLegend(
  runtime: A2ARuntime,
  operationRef: number,
  operationId: string,
): PlaceholderLegendEntry[] {
  return runtime.store.entitiesOf(operationRef).flatMap((row) => {
    const original = unseal(row, operationId);
    return original === null ? [] : [{ placeholder: row.placeholder, original }];
  });
}

/** Forget originals past their hard end, or whose operation ended more than the retention ago. */
export function purgeEndedEntities(runtime: A2ARuntime): number {
  const now = runtime.nowMs();
  return runtime.store.purgeEntities(now, now - ENTITY_RETENTION_AFTER_END_MS);
}
