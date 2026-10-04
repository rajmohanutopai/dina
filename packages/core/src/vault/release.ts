/**
 * The release context of a vault read (A2A design §4.2 (b)): WHO the read's
 * results are released to, and in WHICH conversation. Every read surface
 * Brain can reach — search, get, browse/recent, list, subject recall — takes
 * one, on both boots: the server's routes pass it down from the request, and
 * the phone's in-process calls pass it directly. The recording sits here, in
 * the read functions below every caller, because on the phone Brain calls
 * these functions without passing through `CoreRouter`.
 *
 * A read with no release context records nothing: it was not a release into
 * a conversation (the owner's own browser, a briefing, enrichment). A read
 * WITH one records every item it returns before returning them, and a failed
 * record fails the read: a release Core did not log would make the
 * conversation look cleaner than it is, and taint must never be under-counted.
 */

import type { VaultItem } from '@dina/test-harness';

/** Only Brain is a release audience today; agents read under their own grants and sessions. */
export type ReleaseAudience = 'brain';

export interface ReleaseContext {
  /** The conversation the read serves: Brain's chat thread or ask, as Brain names it. */
  sessionId: string;
  audience: ReleaseAudience;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** A well-formed release session id, or null. */
export function parseReleaseSession(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}

/** Where releases are logged: whole items, and a persona's topic list (the working-memory ToC). */
export interface ReleaseRecorder {
  items(ctx: ReleaseContext, persona: string, items: readonly VaultItem[]): void;
  topics(ctx: ReleaseContext, persona: string, topics: readonly string[]): void;
}

let recorder: ReleaseRecorder | null = null;

/** Install the host's release log (`a2a/release_log.ts`), or remove it. */
export function setVaultReleaseRecorder(next: ReleaseRecorder | null): void {
  recorder = next;
}

/**
 * Record a release. No context: nothing to record. A context with no
 * recorder installed fails the read: the caller asked for a logged release
 * and the log is missing.
 */
export function recordVaultRelease(
  ctx: ReleaseContext | undefined,
  persona: string,
  items: readonly VaultItem[],
): void {
  if (ctx === undefined) return;
  if (recorder === null) throw new Error('vault release: no release log is installed');
  if (items.length === 0) return;
  recorder.items(ctx, persona, items);
}

/**
 * Record that a persona's topics (names from its working-memory ToC) were
 * released into a conversation: they reach the model through the intent
 * classifier, so they taint the conversation like an item would. Same
 * contract as `recordVaultRelease`.
 */
export function recordTopicRelease(ctx: ReleaseContext | undefined, persona: string, topics: readonly string[]): void {
  if (ctx === undefined) return;
  if (recorder === null) throw new Error('vault release: no release log is installed');
  if (topics.length === 0) return;
  recorder.topics(ctx, persona, topics);
}

/** The text fields of an item a release hands out, in a fixed order. */
export function releasedTextFields(item: VaultItem): string[] {
  return [item.summary, item.body, item.content_l0, item.content_l1].map((v) => (typeof v === 'string' ? v : ''));
}
