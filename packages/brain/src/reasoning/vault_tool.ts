/**
 * `vault_search` agentic tool — give the LLM a way to recall memories
 * mid-conversation.
 *
 * The pre-assembly path in `chat_reasoning.reason()` runs ONE vault
 * query at the top of a turn, bakes the result into the prompt, then
 * runs a single LLM call. Fine for "answer from what you already know"
 * but useless when the model realises mid-turn that it needs to look
 * something else up ("user mentioned Emma — let me check if there's a
 * birthday or relationship stored").
 *
 * This tool wraps `executeToolSearch(persona, query, limit)` — the
 * same FTS5-backed search the pre-assembly uses — and exposes it to
 * the agentic loop. With it, the LLM can decide to pull additional
 * vault rows on any turn, the same way it currently decides to
 * geocode / search for providers / dispatch a service query.
 *
 * Scope note: this tool is an OPT-IN per-persona search — the LLM
 * names the persona in its args. It CANNOT escape `getAccessiblePersonas()`;
 * any persona the user hasn't unlocked returns `[]` silently
 * (same guarantee the pre-assembly path gives).
 */

import { ApprovalRequiredError, type AgentTool } from './tool_registry';
import { executeToolSearch, getAccessiblePersonas } from '../vault_context/assembly';
import { getItem, listRecentItems } from '../../../core/src/vault/crud';
import { listPersonas } from '../../../core/src/persona/service';

/**
 * Pluggable per-call gate for content-reading vault tools.
 *
 * Returns:
 *   - `null` (or omitted) → persona is open / accessible, proceed.
 *   - `string` (an approval id) → persona requires approval; the tool
 *     throws `ApprovalRequiredError(approvalId, persona)` which the
 *     `ToolRegistry` translates into an `approval_required` outcome
 *     and the agentic loop turns into a Pattern A bail.
 *
 * The composition layer (mobile boot / brain-server boot) builds a
 * guard that knows about the persona registry's tier, the
 * `ApprovalManager` for minting/consuming approvals, and the
 * surrounding ask context. This module deliberately doesn't reach for
 * any of those — keeping the tool factories framework-free + unit
 * testable with a plain function stub.
 *
 * `list_personas` does NOT use this guard. Returning a name+tier list
 * is intentionally unauthenticated — the LLM needs to know the persona
 * exists in order to ask for approval to read it. The guard fires only
 * on content-reading tools (`vault_search` with a named persona,
 * `browse_vault`, `get_full_content`).
 */
export type VaultPersonaGuard = (persona: string) => Promise<string | null> | string | null;

export interface VaultSearchToolOptions {
  /** Upper limit on how many rows one call can return. */
  maxResults?: number;
  /** Optional pluggable gate — see `VaultPersonaGuard` docstring. */
  personaGuard?: VaultPersonaGuard;
}

export interface VaultBrowseToolOptions {
  personaGuard?: VaultPersonaGuard;
}

export interface VaultGetFullContentToolOptions {
  personaGuard?: VaultPersonaGuard;
}

/**
 * Internal helper — runs the guard (if wired) and throws if approval required.
 *
 * Fail-closed contract:
 *   - `null` / `undefined`     → allow (open persona).
 *   - non-empty string         → throw `ApprovalRequiredError`.
 *   - empty string             → throw a regular `Error` (fail-closed).
 *     Returning '' indicates a guard misconfiguration (couldn't mint
 *     an approval id). Letting the read proceed would silently bypass
 *     the gate; surfacing a hard error makes the bug visible without
 *     leaking vault contents.
 */
async function checkPersonaGuard(
  guard: VaultPersonaGuard | undefined,
  persona: string,
): Promise<void> {
  if (!guard) return;
  const result = await guard(persona);
  if (result === null || result === undefined) return;
  if (typeof result !== 'string') {
    throw new Error(
      `personaGuard for "${persona}" returned non-string ${typeof result} — refusing read`,
    );
  }
  if (result === '') {
    throw new Error(
      `personaGuard for "${persona}" returned empty approvalId — refusing read (fail-closed)`,
    );
  }
  throw new ApprovalRequiredError(result, persona);
}

const DEFAULT_MAX_RESULTS = 10;
/** Preview length for `list_personas` + `browse_vault` — matches Python's
 *  `_BROWSE_LIMIT`. The LLM only needs a sniff of what's in a persona,
 *  not a full dump. */
const BROWSE_LIMIT = 10;
/** Summary-field cap when previewing — keeps prompt token count sane on
 *  verbose items. Python clips at 100 for the per-persona summary block. */
const PREVIEW_SUMMARY_CHARS = 100;
/** Per-field cap for browse_vault entries — matches Python's 500. */
const BROWSE_FIELD_CHARS = 500;

/**
 * Factory — returns an `AgentTool` the reasoning loop can register.
 * The shape matches the other agentic tools (name + description +
 * parameters schema + execute).
 */
export function createVaultSearchTool(options: VaultSearchToolOptions = {}): AgentTool {
  const cap = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const personaGuard = options.personaGuard;

  return {
    name: 'vault_search',
    description:
      "Search the user's own memory (the vault) for items matching a free-text query. Use this ANY time the user asks about something personal, a prior fact, or an event they might have told you before — before answering from general knowledge. By default, searches ALL unlocked personas (recommended) — the persona-routing pass at ingest may have placed an item in 'general' even when its topic looks like 'health' or 'financial'. Pass `persona` only when the user's question explicitly names one (e.g. \"in my health vault\", \"check my work notes\").",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search query — e.g. "emma birthday", "dentist appointment", "passport number". Tokens are matched case-insensitively against summary/body/content_l0/content_l1.',
        },
        persona: {
          type: 'string',
          description:
            "OPTIONAL. Restrict the search to a single persona vault (e.g. 'health', 'financial', 'family', 'general'). OMIT to fan out across every unlocked persona — almost always the right choice unless the user explicitly named a vault. Locked personas silently return [].",
        },
        limit: {
          type: 'number',
          description: `Max rows to return. Server caps at ${cap}.`,
        },
      },
      required: ['query'],
    },
    async execute(args): Promise<{
      persona: string;
      personas_searched: string[];
      query: string;
      accessible: boolean;
      results: Array<{
        id: string;
        content_l0: string;
        content_l1?: string;
        body?: string;
        score: number;
        persona: string;
      }>;
    }> {
      const query = String(args.query ?? '');
      if (query === '') throw new Error('vault_search: query is required');
      const requestedLimit = typeof args.limit === 'number' ? args.limit : undefined;
      const limit = requestedLimit !== undefined ? Math.min(requestedLimit, cap) : cap;

      const namedPersona =
        typeof args.persona === 'string' && args.persona.trim() !== ''
          ? args.persona.trim()
          : null;

      // Single-persona path — LLM explicitly named one. Run the
      // pluggable guard FIRST so a sensitive/locked persona can bail
      // the agentic loop with `ApprovalRequiredError` (Pattern A
      // suspend/resume). When no guard is wired we fall back to the
      // legacy "accessible:false on locked" signal so the LLM can
      // tell the user the vault is locked.
      if (namedPersona !== null) {
        await checkPersonaGuard(personaGuard, namedPersona);
        const accessible = getAccessiblePersonas().includes(namedPersona);
        const rows = await executeToolSearch(namedPersona, query, limit);
        return {
          persona: namedPersona,
          personas_searched: [namedPersona],
          query,
          accessible,
          results: rows,
        };
      }

      // Default — fan out across every unlocked persona, merge by score.
      // Eliminates the over-scope class of bug where the LLM would pick
      // 'health' for "what was my BP?" and miss items the drain routed
      // to 'general'. Per-row persona stays in each result so the LLM
      // can still cite the source vault.
      const accessiblePersonas = getAccessiblePersonas();
      const merged: Array<{
        id: string;
        content_l0: string;
        content_l1?: string;
        body?: string;
        score: number;
        persona: string;
      }> = [];

      for (const persona of accessiblePersonas) {
        const rows = await executeToolSearch(persona, query, limit);
        merged.push(...rows);
      }
      merged.sort((a, b) => b.score - a.score);
      const trimmed = merged.slice(0, limit);

      return {
        persona: 'all',
        personas_searched: accessiblePersonas,
        query,
        accessible: accessiblePersonas.length > 0,
        results: trimmed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// `list_personas` — enumerate available personas with previews
// ---------------------------------------------------------------------------

/**
 * Port of Python `vault_context.py::_list_personas`. Walks every
 * persona the user has registered, reads the most-recent items (empty
 * FTS query → most-recent order), and returns a tight summary block
 * the LLM can skim to decide which persona to dig into next.
 *
 * Locked / inaccessible personas surface as `{status: 'locked'}` rather
 * than throwing — the LLM is told to skip them silently per the
 * `VAULT_CONTEXT` prompt.
 */
export function createListPersonasTool(): AgentTool {
  return {
    name: 'list_personas',
    description:
      "Enumerate the user's persona vaults with a short preview (item count + types + top-5 summaries) for each. Call this first when the user's question doesn't name a persona — the previews tell you which persona to search. Locked personas surface as {status:'locked'}; skip them silently.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(): Promise<{
      personas: Array<{
        name: string;
        item_count?: number;
        types?: string[];
        recent_summaries?: string[];
        status?: string;
      }>;
    }> {
      const accessible = new Set(getAccessiblePersonas());
      const all = listPersonas();
      const out: Array<{
        name: string;
        item_count?: number;
        types?: string[];
        recent_summaries?: string[];
        status?: string;
      }> = [];

      for (const p of all) {
        const entry: {
          name: string;
          item_count?: number;
          types?: string[];
          recent_summaries?: string[];
          status?: string;
        } = { name: p.name };

        if (!accessible.has(p.name)) {
          entry.status = 'locked';
          out.push(entry);
          continue;
        }

        try {
          // Most-recent items (no search term) — matches Python's
          // `core.search_vault(persona, query="")` semantics via the
          // timestamp-DESC helper. Capped at BROWSE_LIMIT so a huge
          // vault doesn't blow the prompt.
          const items = listRecentItems(p.name, BROWSE_LIMIT);
          entry.item_count = items.length;
          const types = new Set<string>();
          const summaries: string[] = [];
          for (const it of items) {
            if (it.type) types.add(it.type);
            if (summaries.length < 5 && it.summary) {
              summaries.push(it.summary.slice(0, PREVIEW_SUMMARY_CHARS));
            }
          }
          entry.types = [...types];
          entry.recent_summaries = summaries;
        } catch {
          // Backend I/O failure — report "browse_failed" the LLM can
          // reason about instead of a crashy tool error.
          entry.status = 'browse_failed';
        }

        out.push(entry);
      }

      return { personas: out };
    },
  };
}

// ---------------------------------------------------------------------------
// `browse_vault` — recent contents of one persona, no search term
// ---------------------------------------------------------------------------

/**
 * Port of Python `vault_context.py::_browse_vault`. For the case where
 * the user's question is open-ended ("what's in my health vault?"):
 * return the most recent BROWSE_LIMIT items with their summary + body
 * + provenance fields capped at 500 chars each (matches Python).
 */
export function createBrowseVaultTool(options: VaultBrowseToolOptions = {}): AgentTool {
  const personaGuard = options.personaGuard;
  return {
    name: 'browse_vault',
    description:
      "Return the most recent items from a persona vault (no search query — use when the user's question is broad enough that search terms don't apply). Call list_personas first to know which persona to browse. Returns up to 10 items with summary/body/type/sender/sender_trust/content_l0/content_l1.",
    parameters: {
      type: 'object',
      properties: {
        persona: {
          type: 'string',
          description: 'Persona name to browse (e.g. "general", "health").',
        },
      },
      required: ['persona'],
    },
    async execute(args): Promise<{
      persona: string;
      items: Array<Record<string, string>>;
      note?: string;
    }> {
      const persona =
        typeof args.persona === 'string' && args.persona !== '' ? args.persona : '';
      if (persona === '') throw new Error('browse_vault: persona is required');

      // Pluggable gate — sensitive/locked personas bail the loop with
      // ApprovalRequiredError. Falls through to the legacy accessibility
      // check when no guard is wired.
      await checkPersonaGuard(personaGuard, persona);

      if (!getAccessiblePersonas().includes(persona)) {
        return {
          persona,
          items: [],
          note: `Persona '${persona}' is locked. Skip it.`,
        };
      }

      let rawItems;
      try {
        rawItems = listRecentItems(persona, BROWSE_LIMIT);
      } catch {
        return { persona, items: [] };
      }

      const simplified: Array<Record<string, string>> = [];
      for (const item of rawItems.slice(0, BROWSE_LIMIT)) {
        const entry: Record<string, string> = {};
        pushIfPresent(entry, 'summary', item.summary);
        pushIfPresent(entry, 'body_text', item.body);
        pushIfPresent(entry, 'type', item.type);
        pushIfPresent(entry, 'id', item.id);
        pushIfPresent(entry, 'sender', item.sender);
        pushIfPresent(entry, 'sender_trust', item.sender_trust);
        pushIfPresent(entry, 'confidence', item.confidence);
        pushIfPresent(entry, 'retrieval_policy', item.retrieval_policy);
        pushIfPresent(entry, 'content_l0', item.content_l0);
        pushIfPresent(entry, 'content_l1', item.content_l1);
        pushIfPresent(entry, 'enrichment_status', item.enrichment_status);
        if (Object.keys(entry).length > 0) simplified.push(entry);
      }
      return { persona, items: simplified };
    },
  };
}

// ---------------------------------------------------------------------------
// `get_full_content` — fetch full L2 body by item id
// ---------------------------------------------------------------------------

/**
 * Port of Python `vault_context.py::_get_full_content`. The three other
 * vault tools cap body length — when the LLM needs the complete
 * original document (specific numbers, full text, legal citations)
 * this tool returns it uncapped.
 *
 * The `VAULT_CONTEXT` prompt rule ("Only call get_full_content when
 * you need the complete original document") keeps this off the hot
 * path — it's a fetch-by-id, not a search.
 */
export function createGetFullContentTool(
  options: VaultGetFullContentToolOptions = {},
): AgentTool {
  const personaGuard = options.personaGuard;
  return {
    name: 'get_full_content',
    description:
      "Fetch the full (L2) content of a specific vault item by id. Use only when content_l1 isn't enough — e.g. user asks for exact numbers, full body, or specific citations. Requires both persona and item_id (from a prior vault_search / browse_vault / list_personas result).",
    parameters: {
      type: 'object',
      properties: {
        persona: {
          type: 'string',
          description: 'Persona the item lives in.',
        },
        item_id: {
          type: 'string',
          description: 'Exact vault item id (from a prior tool call).',
        },
      },
      required: ['persona', 'item_id'],
    },
    async execute(args): Promise<
      | { error: string }
      | {
          persona: string;
          id: string;
          summary?: string;
          body?: string;
          type?: string;
          sender?: string;
          sender_trust?: string;
          content_l0?: string;
          content_l1?: string;
        }
    > {
      const persona =
        typeof args.persona === 'string' && args.persona !== '' ? args.persona : '';
      const itemId =
        typeof args.item_id === 'string' && args.item_id !== '' ? args.item_id : '';
      if (persona === '' || itemId === '') {
        return { error: 'persona and item_id are required' };
      }
      // Pluggable gate — sensitive/locked personas bail the loop with
      // ApprovalRequiredError. Falls through to the legacy accessibility
      // check when no guard is wired.
      await checkPersonaGuard(personaGuard, persona);
      if (!getAccessiblePersonas().includes(persona)) {
        return { error: `Persona '${persona}' is locked` };
      }

      const item = getItem(persona, itemId);
      if (item === null) return { error: `Item ${itemId} not found in ${persona}` };

      return {
        persona,
        id: item.id,
        ...(item.summary ? { summary: item.summary } : {}),
        ...(item.body ? { body: item.body } : {}),
        ...(item.type ? { type: item.type } : {}),
        ...(item.sender ? { sender: item.sender } : {}),
        ...(item.sender_trust ? { sender_trust: item.sender_trust } : {}),
        ...(item.content_l0 ? { content_l0: item.content_l0 } : {}),
        ...(item.content_l1 ? { content_l1: item.content_l1 } : {}),
      };
    },
  };
}

/** Helper — only write the key when the value is a non-empty string,
 *  trimmed to `BROWSE_FIELD_CHARS`. Matches Python's `if val: entry[k] = str(val)[:500]`. */
function pushIfPresent(
  entry: Record<string, string>,
  key: string,
  value: string | undefined | null,
): void {
  if (value === null || value === undefined) return;
  const s = String(value);
  if (s === '') return;
  entry[key] = s.slice(0, BROWSE_FIELD_CHARS);
}
