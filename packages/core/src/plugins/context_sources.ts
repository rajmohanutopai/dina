/**
 * WHERE A PROJECTION'S CANDIDATES COME FROM (PLUGIN_ARCHITECTURE.md §11).
 *
 * "Runner plugins are push-only. No pull path at all … Context reaches an
 * instance only inside task payloads, assembled per invocation."
 *
 * Assembled by whom? By Core, from stores Core already keeps. This module is
 * the seam that lets Core do it without the plugin substrate importing the
 * commerce domain: a source is registered BY the module that owns the store,
 * and the projector only ever knows a category name and a function.
 *
 * WHY THE SUBJECT IS AN IDENTITY AND NOT A PAYLOAD. A source is handed who
 * and what the task is about — a contact DID, a retained document's digest —
 * never facts to pass along. Naming a counterparty is not push-context: Core
 * still decides which facts about them travel, through the templates. If the
 * caller could hand over the facts themselves, every caller would be a
 * projector and the template table would be advice.
 *
 * FAIL-CLOSED BY ABSENCE. A category with no registered source yields no
 * candidates, so a manifest that declares a category Dina has no store for
 * receives nothing rather than something approximate. The projection reports
 * that category as unsourced, so the silence is visible to the owner rather
 * than being mistaken for "there was nothing to send".
 */

/** Who and what an invocation is about. Identities, never content. */
export interface InvocationSubject {
  /** The counterparty this task concerns, when it concerns one. */
  contactDid?: string;
  /** The retained document this task is about (a khata note digest). */
  documentDigest?: string;
}

export interface ContextSourceRequest {
  /** The category being gathered — a source may serve more than one. */
  category: string;
  /** The capability's action class, in case a source holds back for a lookup. */
  actionClass: string;
  subject: InvocationSubject;
  nowMs: number;
}

/**
 * One candidate the projector may shape. `fields` is raw — whatever the store
 * holds — because shaping it is the template's job, not a source's. A source
 * that pre-formats is a second place where the rules live.
 */
export interface ContextCandidate {
  readonly category: string;
  /**
   * The persona this item came from, for the tier filter. ABSENT means the
   * item is not persona-scoped at all: the owner's contact directory and
   * business settings live in the Tier-0 identity store, which belongs to no
   * persona. The distinction matters at the filter — a manifest that names
   * personas is asking for persona-vault data, and a Tier-0 row is not that.
   */
  readonly persona?: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type ContextSource = (request: ContextSourceRequest) => readonly ContextCandidate[];

const sources = new Map<string, ContextSource>();

/**
 * Register (or clear, with null) the source for one category. Called by the
 * module that owns the store, at the same moment its runtime is installed —
 * the pattern the probing ledger and the presence verifier already use, so
 * neither of the two boots can forget one of them.
 */
export function setContextSource(category: string, source: ContextSource | null): void {
  if (source === null) sources.delete(category);
  else sources.set(category, source);
}

/** Drop every registered source. Shutdown, lock, and test isolation. */
export function clearContextSources(): void {
  sources.clear();
}

export function getContextSource(category: string): ContextSource | null {
  return sources.get(category) ?? null;
}
