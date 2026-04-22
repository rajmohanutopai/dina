/**
 * Ingest-time topic touch + preference binding (PC-BRAIN-13,
 * superseding WM-BRAIN-03).
 *
 * After a staging item is successfully resolved this pipeline:
 *
 *   1. Extracts entities + themes via `TopicExtractor` (WM-BRAIN-01).
 *   2. For each persona the item was classified into, calls
 *      `core.memoryTouch` once per topic. Per-call try/catch means
 *      a single failure does not stop the batch.
 *   3. Runs the `PreferenceExtractor` (PC-BRAIN-12) over the
 *      summary + body. For each candidate it resolves a contact by
 *      name, merges the candidate's categories into the contact's
 *      existing `preferredFor` list (set-union; doesn't clobber),
 *      and writes via `core.updateContact` when the merge yields
 *      new categories. Merges that produce no delta are skipped
 *      locally (no round-trip).
 *   4. Wraps every step so topic / preference failures NEVER fail
 *      the ingest itself — the vault item is already stored.
 *
 * Replaces the old `DiscoverabilityCache` + `live_capability`
 * path (PC-BRAIN-14 deleted that module outright): capability
 * bindings now live on the Contact row (`preferredFor`), not on
 * ToC memory. See docs/WORKING_MEMORY_DESIGN.md §6.1 and
 * docs/PREFERRED_CONTACTS_PORT_TASKS.md for the rationale.
 */

import type { TopicExtractor } from './topic_extractor';
import type { PreferenceExtractor } from './preference_extractor';

/** Minimum `BrainCoreClient` surface needed by the pipeline. */
export interface TopicTouchCoreClient {
  memoryTouch(req: {
    persona: string;
    topic: string;
    kind: 'entity' | 'theme';
    sampleItemId?: string;
  }): Promise<{ status: 'ok' | 'skipped'; canonical?: string; reason?: string }>;
  updateContact(did: string, updates: { preferredFor?: string[] }): Promise<void>;
}

/** The subset of the resolved staging item the pipeline needs. */
export interface TouchableItem {
  id: string;
  personas: string[];
  summary?: string;
  content_l0?: string;
  content_l1?: string;
  body?: string;
}

/**
 * A contact resolved from a name string (may include an honorific
 * prefix like "Dr "). Returned by `resolveContact`; used by the
 * pipeline's preference-binding step to merge categories into an
 * existing `preferredFor` list.
 */
export interface ResolvedContact {
  did: string;
  preferredFor: string[];
}

/**
 * Look up a contact by a raw name string. Case-insensitive. Returns
 * null when no match. The caller is responsible for the lookup
 * strategy — production wires the directory's alias index; tests
 * inject a fake map. The pipeline itself tries a secondary lookup
 * with the honorific prefix stripped ("Dr Carl" → "Carl") when the
 * first-pass match fails, so `resolveContact` only needs to
 * implement the direct lookup.
 */
export type ContactResolver = (name: string) => ResolvedContact | null;

export interface TopicTouchPipelineOptions {
  extractor: TopicExtractor;
  core: TopicTouchCoreClient;
  /**
   * Optional preference-binding hooks. Both must be supplied
   * together for preference binding to run — tests that only want
   * to exercise topic touches can omit them.
   */
  preferenceExtractor?: PreferenceExtractor;
  resolveContact?: ContactResolver;
  /** Structured-log sink. Emits `memory_touch.*` / `preference_bind.*` events. */
  logger?: (entry: Record<string, unknown>) => void;
}

export interface TopicTouchResult {
  /** Count of topic touches that returned `ok` or `skipped`. */
  touched: number;
  /** Count of topic touches that failed. */
  failed: number;
  /** Count of preference bindings that landed (wrote to a contact). */
  preferencesBound: number;
  /** Count of preference bindings that failed (log + swallow). */
  preferencesFailed: number;
}

/**
 * Run the topic extraction + touch pipeline + preference binding
 * for a single resolved item. Never throws — failures are logged
 * and returned as counts so the staging processor can surface them
 * in its batch summary.
 */
export async function touchTopicsForItem(
  item: TouchableItem,
  opts: TopicTouchPipelineOptions,
): Promise<TopicTouchResult> {
  const log =
    opts.logger ??
    (() => {
      /* no-op */
    });
  const result: TopicTouchResult = {
    touched: 0,
    failed: 0,
    preferencesBound: 0,
    preferencesFailed: 0,
  };

  let entities: string[];
  let themes: string[];
  try {
    ({ entities, themes } = await opts.extractor.extract(item));
  } catch (err) {
    // Extractor already fails open, but catch defensively so a
    // future regression doesn't poison the ingest.
    log({
      event: 'memory_touch.extract_failed',
      item_id: item.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  const personas = item.personas.length > 0 ? item.personas : ['general'];
  const sampleItemId = `stg-${item.id}`;

  for (const persona of personas) {
    for (const entity of entities) {
      const ok = await safeTouch(opts.core, log, {
        persona,
        topic: entity,
        kind: 'entity',
        sampleItemId,
      });
      ok ? result.touched++ : result.failed++;
    }
    for (const theme of themes) {
      const ok = await safeTouch(opts.core, log, {
        persona,
        topic: theme,
        kind: 'theme',
        sampleItemId,
      });
      ok ? result.touched++ : result.failed++;
    }
  }

  // PC-BRAIN-13: preference binding. Runs AFTER topic touches so a
  // failure in this block never blocks memory updates. Best-effort
  // across the board — every error is logged + swallowed so a
  // transient Core hiccup doesn't fail ingest.
  if (opts.preferenceExtractor !== undefined && opts.resolveContact !== undefined) {
    const text = [item.summary ?? '', item.body ?? ''].filter((s) => s !== '').join('\n');
    if (text !== '') {
      try {
        await applyPreferenceBindings(
          item.id,
          text,
          opts.preferenceExtractor,
          opts.resolveContact,
          opts.core,
          log,
          result,
        );
      } catch (err) {
        // Belt-and-braces: the inner helper already catches, but a
        // future regression must never fail ingest via preferences.
        log({
          event: 'preference_bind.unexpected_error',
          item_id: item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Preference binding (PC-BRAIN-13)
// ---------------------------------------------------------------------------

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof']);

async function applyPreferenceBindings(
  itemId: string,
  text: string,
  extractor: PreferenceExtractor,
  resolve: ContactResolver,
  core: TopicTouchCoreClient,
  log: (entry: Record<string, unknown>) => void,
  result: TopicTouchResult,
): Promise<void> {
  const candidates = extractor.extract(text);
  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    // First pass: direct name lookup. The resolver is expected to
    // match case-insensitively (directory aliases are
    // lowercase-indexed in production).
    let contact = resolve(candidate.name);
    if (contact === null) {
      // Secondary pass: drop an honorific prefix ("Dr Carl" → "Carl")
      // so a contact stored as "Carl Jones" with alias "Dr Carl"
      // still matches if the alias wasn't indexed.
      const stripped = stripHonorific(candidate.name);
      if (stripped !== null) {
        contact = resolve(stripped);
      }
    }
    if (contact === null) {
      log({
        event: 'preference_bind.no_contact',
        item_id: itemId,
        role: candidate.role,
        name: candidate.name,
      });
      continue;
    }

    // Set-union the new categories with the existing list. `[]` base
    // case covers contacts that haven't been bound yet.
    const existing = contact.preferredFor ?? [];
    const merged = dedupLowercase([...existing, ...candidate.categories]);
    const addedCount = merged.length - existing.length;
    if (addedCount === 0) {
      // Nothing new — skip the network write.
      continue;
    }

    try {
      await core.updateContact(contact.did, { preferredFor: merged });
      result.preferencesBound++;
      log({
        event: 'preference_bind.applied',
        item_id: itemId,
        did: contact.did,
        role: candidate.role,
        categories_added: candidate.categories.filter((c) => !existing.includes(c)),
      });
    } catch (err) {
      result.preferencesFailed++;
      log({
        event: 'preference_bind.update_failed',
        item_id: itemId,
        did: contact.did,
        role: candidate.role,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Drop a leading honorific ("Dr ", "Mr. ", "Ms.") so the stripped
 * name ("Carl" from "Dr Carl", "Jones" from "Mrs. Jones") can be
 * tried as a fallback contact lookup. Returns null when the name
 * has no recognised honorific — the caller stops looking at that
 * point.
 *
 * Case-insensitive; dot is optional ("Dr" / "Dr.").
 */
function stripHonorific(name: string): string | null {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const head = parts[0].toLowerCase().replace(/\.$/, '');
  if (!HONORIFICS.has(head)) return null;
  return parts.slice(1).join(' ');
}

/**
 * Dedup case-insensitively, preserving first-seen ordering. The
 * stored `preferredFor` values are already normalised by Core's
 * repository (lowercase + trim + dedup), so this function normally
 * runs against clean input. The explicit dedup here guards against
 * a pathological caller sending the SAME category twice in one
 * merge call.
 */
function dedupLowercase(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Topic-touch primitive
// ---------------------------------------------------------------------------

/**
 * Per-call try/catch wrapper. `memoryTouch` failures are logged and
 * swallowed so one bad topic row doesn't poison the batch. Returns
 * `true` on success (including `status: "skipped"`, which is Core's
 * explicit "persona not open" soft no-op).
 */
async function safeTouch(
  core: TopicTouchCoreClient,
  log: (entry: Record<string, unknown>) => void,
  req: {
    persona: string;
    topic: string;
    kind: 'entity' | 'theme';
    sampleItemId: string;
  },
): Promise<boolean> {
  try {
    const res = await core.memoryTouch(req);
    if (res.status === 'skipped') {
      log({
        event: 'memory_touch.skipped',
        persona: req.persona,
        topic: req.topic,
        reason: res.reason,
      });
    }
    return true;
  } catch (err) {
    log({
      event: 'memory_touch.failed',
      persona: req.persona,
      topic: req.topic,
      kind: req.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
