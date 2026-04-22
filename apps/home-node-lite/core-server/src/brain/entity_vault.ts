/**
 * Task 5.34 — Entity Vault: ephemeral PII tokenisation for cloud LLM calls.
 *
 * The Entity Vault is a per-request, in-memory map from anonymisation
 * tokens (`<PERSON_1>`, `<ORG_1>`, `<EMAIL_1>`, …) back to original
 * PII values. The lifecycle is tight:
 *
 *   1. Build the vault from tier-1 (Core regex) + tier-2 (Presidio
 *      NER) entity detections.
 *   2. Send the **scrubbed** text to the cloud LLM.
 *   3. Rehydrate the LLM response by replacing tokens with originals.
 *   4. Discard the vault.
 *
 * **Security invariants** (must NEVER be violated — pinned by tests):
 *   - The vault map is NEVER persisted (no disk, no DB).
 *   - Original PII NEVER appears in any log output — only the vault
 *     size + token counts are loggable.
 *   - Each concurrent cloud LLM call uses an independent vault — no
 *     cross-contamination across requests.
 *   - Token namespace is per-entity-type + monotonic within a vault,
 *     so `<PERSON_1>` and `<EMAIL_1>` are distinct slots.
 *   - Round-trip stability: `rehydrate(scrubbed) === originalText`
 *     when every span is a known entity.
 *   - Unknown tokens in the rehydrate input are left as-is (the LLM
 *     inventing `<PERSON_99>` must not crash + must not leak).
 *
 * **Disjoint-span constraint**: the caller is responsible for passing
 * in non-overlapping spans. Overlapping entity spans are rejected up
 * front — an overlap means the scrubbers disagreed and the safe
 * action is to fail closed rather than produce a ambiguous vault.
 *
 * **Not an LLM invoker** — this module only handles tokenise +
 * rehydrate. A caller composes it with the LLM call + the scrubber
 * (`@dina/pii-node` / Core's `POST /v1/pii/scrub`). Keeping the
 * primitive tight means tests cover the mapping logic without any
 * scrubber/LLM stubs.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.34.
 */

/**
 * Entity kinds the vault recognises. Keep it small + deliberately
 * constrained — new kinds must be added on both the scrubber + the
 * rehydrate regex path, so we don't accept arbitrary strings.
 */
export type EntityType =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'ORG'
  | 'LOCATION'
  | 'SSN'
  | 'CREDIT_CARD'
  | 'DATE'
  | 'URL'
  | 'ID';

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  'PERSON',
  'EMAIL',
  'PHONE',
  'ORG',
  'LOCATION',
  'SSN',
  'CREDIT_CARD',
  'DATE',
  'URL',
  'ID',
]);

/** A single entity span detected by the scrubber. */
export interface DetectedEntity {
  type: EntityType;
  /** Start offset (inclusive). */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** Original text (the substring of the input at [start, end)). */
  value: string;
}

export interface TokeniseResult {
  /** Text with PII replaced by tokens. */
  scrubbedText: string;
  /** New vault. Caller passes this to `rehydrate()` later. */
  vault: EntityVault;
  /** Token counts per type, for telemetry. */
  counts: Partial<Record<EntityType, number>>;
}

export type TokeniseOutcome =
  | { ok: true; result: TokeniseResult }
  | { ok: false; reason: 'overlapping_spans'; detail: string }
  | { ok: false; reason: 'invalid_entity_type'; detail: string }
  | { ok: false; reason: 'out_of_bounds'; detail: string };

/**
 * Ephemeral token→value map. One instance per cloud LLM call. Never
 * serialise. Never log. Never persist.
 */
export class EntityVault {
  private readonly map: Map<string, string> = new Map();

  /** Number of mappings stored. Safe to log (no values leak). */
  get size(): number {
    return this.map.size;
  }

  /** Register a (token, originalValue) pair. Internal — used by tokenise. */
  set(token: string, value: string): void {
    this.map.set(token, value);
  }

  /** Look up an original value by token. Returns null for unknown tokens. */
  get(token: string): string | null {
    const v = this.map.get(token);
    return v === undefined ? null : v;
  }

  /**
   * Replace every known token in `text` with its original value.
   * Unknown-shape tokens are left as-is (the LLM may hallucinate
   * `<PERSON_99>` for a slot we never populated; failing that should
   * not crash the pipeline).
   */
  rehydrate(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text ?? '';
    // Pass 1: match every `<TYPE_N>` token + resolve if known. We do
    // a single pass + use a replacer so concurrent rehydrations don't
    // race (each allocates its own result string).
    return text.replace(TOKEN_REGEX, (match) => {
      const original = this.map.get(match);
      return original !== undefined ? original : match;
    });
  }

  /** Token count per type — exposed for tests + telemetry. */
  countsByType(): Partial<Record<EntityType, number>> {
    const out: Partial<Record<EntityType, number>> = {};
    for (const token of this.map.keys()) {
      const m = TYPE_PARSE.exec(token);
      if (!m) continue;
      const type = m[1] as EntityType;
      out[type] = (out[type] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Security: return a redacted audit line — never expose values.
   * Shape: `"EntityVault{size=N, counts={PERSON:3, EMAIL:1}}"`. Safe
   * for logs.
   */
  toString(): string {
    const counts = this.countsByType();
    const inner = Object.entries(counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    return `EntityVault{size=${this.size}, counts={${inner}}}`;
  }

  /**
   * Node's `util.inspect` hook — some logging frameworks bypass
   * `toString()`. Point it at the same redacted form.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }

  /**
   * Block JSON serialisation outright. If a bug tries to
   * `JSON.stringify(vault)`, we want it to surface as an error, not
   * silently dump the map contents.
   */
  toJSON(): never {
    throw new Error(
      'EntityVault: refuse to serialise — vault contains PII tokens and must stay in-process',
    );
  }
}

/**
 * Tokenise `text` by replacing each detected entity span with a
 * type-scoped monotonic token. Returns a fresh `EntityVault` the
 * caller passes to the LLM flow and later to `rehydrate`.
 *
 * The scrubbed text preserves the surrounding text exactly — tokens
 * replace only the entity span.
 */
export function tokenise(
  text: string,
  entities: ReadonlyArray<DetectedEntity>,
): TokeniseOutcome {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'out_of_bounds', detail: 'text must be a string' };
  }
  // Validate + sort spans.
  const normalised: DetectedEntity[] = [];
  for (const [i, e] of entities.entries()) {
    if (!VALID_ENTITY_TYPES.has(e?.type as EntityType)) {
      return {
        ok: false,
        reason: 'invalid_entity_type',
        detail: `entity[${i}].type=${JSON.stringify(e?.type)}`,
      };
    }
    if (
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < 0 ||
      e.end > text.length ||
      e.start >= e.end
    ) {
      return {
        ok: false,
        reason: 'out_of_bounds',
        detail: `entity[${i}] span=[${e.start},${e.end}) textLen=${text.length}`,
      };
    }
    // Verify the caller's `value` matches the actual substring — a
    // mismatch means the caller sent us inconsistent metadata and
    // the vault would rehydrate to wrong text.
    if (text.slice(e.start, e.end) !== e.value) {
      return {
        ok: false,
        reason: 'out_of_bounds',
        detail: `entity[${i}] value mismatch at [${e.start},${e.end})`,
      };
    }
    normalised.push({ ...e });
  }
  // Sort by start to build the scrubbed string in one pass.
  normalised.sort((a, b) => a.start - b.start);
  // Reject overlapping spans.
  for (let i = 1; i < normalised.length; i++) {
    if (normalised[i - 1]!.end > normalised[i]!.start) {
      return {
        ok: false,
        reason: 'overlapping_spans',
        detail: `entity[${i - 1}]=[${normalised[i - 1]!.start},${normalised[i - 1]!.end}) overlaps entity[${i}]=[${normalised[i]!.start},${normalised[i]!.end})`,
      };
    }
  }

  // Build vault + scrubbed text.
  const vault = new EntityVault();
  // counterByType assigns monotonic slots per type.
  const counterByType = new Map<EntityType, number>();
  // To keep repeated identical values collapsing to the same token —
  // ("Alice" mentioned 5 times → single `<PERSON_1>`) — we map value
  // to the already-issued token.
  const valueToToken = new Map<string, string>();

  let scrubbed = '';
  let cursor = 0;
  for (const e of normalised) {
    scrubbed += text.slice(cursor, e.start);
    const valueKey = `${e.type}:${e.value}`;
    let token = valueToToken.get(valueKey);
    if (token === undefined) {
      const next = (counterByType.get(e.type) ?? 0) + 1;
      counterByType.set(e.type, next);
      token = `<${e.type}_${next}>`;
      vault.set(token, e.value);
      valueToToken.set(valueKey, token);
    }
    scrubbed += token;
    cursor = e.end;
  }
  scrubbed += text.slice(cursor);

  const counts: Partial<Record<EntityType, number>> = {};
  for (const [t, n] of counterByType) counts[t] = n;
  return { ok: true, result: { scrubbedText: scrubbed, vault, counts } };
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Matches `<TYPE_N>` tokens where TYPE is any known entity type.
 * Built from `VALID_ENTITY_TYPES` so new types only need to be added
 * in one place.
 */
const TOKEN_REGEX = new RegExp(
  `<(?:${Array.from(VALID_ENTITY_TYPES).join('|')})_\\d+>`,
  'g',
);

const TYPE_PARSE = /<([A-Z_]+)_\d+>/;
