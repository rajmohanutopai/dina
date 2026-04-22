/**
 * Task 5.10 — CoreClient interface.
 *
 * The `CoreClient` is the ONLY surface through which Brain talks to
 * Core. Every Brain handler that reaches the vault, the PII
 * scrubber, or the notify dispatcher goes through this interface.
 *
 * **Why an interface (not a class)**:
 *   - Production wires the signed-HTTP client from `@dina/net-node`
 *     as `HttpCoreClient`.
 *   - Tests pass `NullCoreClient` (this module's reference) or
 *     scripted stubs.
 *   - Mobile In-Process transport (Phase 1c) implements the same
 *     interface over function calls, no HTTP.
 *
 * The single `CoreClient` interface means handlers written against
 * it automatically run under all three transports.
 *
 * **Surface** covers the method set the handlers actually use —
 * vault query + store, PII scrub, notify, persona list, reminder
 * store. Extending the interface is the standard way to add a new
 * Core capability.
 *
 * **Never throws inline** — every method returns a structured
 * outcome (ok/fail discriminated union). Transport failures land
 * in the `fail` branch so handlers switch on the reason rather
 * than handling HTTP codes.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.10.
 */

// ══════════════════════════════════════════════════════════════════════
// Vault
// ══════════════════════════════════════════════════════════════════════

export interface VaultItem {
  id: string;
  persona: string;
  type: string;
  source: string;
  summary: string;
  body?: string;
  bodyText?: string;
  /** L0 + L1 enrichment fields — task 5.37. */
  contentL0?: string;
  contentL1?: string;
  /** Wall-clock seconds. */
  timestamp: number;
  /** Optional structured metadata — free-form JSON. */
  metadata?: Record<string, unknown>;
}

export interface VaultQueryInput {
  persona: string;
  query: string;
  mode?: 'fts5' | 'semantic' | 'hybrid';
  maxItems?: number;
  /** Optional: restrict to these item types. */
  types?: string[];
  /** Optional: restrict to this source. */
  source?: string;
  /** Optional: UTC seconds — only items newer than this. */
  sinceSeconds?: number;
}

export interface VaultStoreInput {
  persona: string;
  item: Omit<VaultItem, 'id'> & { id?: string };
}

// ══════════════════════════════════════════════════════════════════════
// PII
// ══════════════════════════════════════════════════════════════════════

export type PiiSensitivity = 'general' | 'elevated' | 'sensitive' | 'local_only';

export interface PiiScrubInput {
  text: string;
  sensitivity?: PiiSensitivity;
  /** When true, return the original→token map for rehydration. */
  includeEntityMap?: boolean;
}

export interface PiiScrubResult {
  scrubbedText: string;
  /** Token → original value — present when `includeEntityMap: true`. */
  entityMap: Record<string, string>;
  /** Counts by entity type for telemetry. */
  counts: Record<string, number>;
}

// ══════════════════════════════════════════════════════════════════════
// Notify
// ══════════════════════════════════════════════════════════════════════

export type NotifyPriority = 'fiduciary' | 'solicited' | 'engagement';

export interface NotifyInput {
  priority: NotifyPriority;
  message: string;
  /** Optional structured metadata for the CLI/admin UI. */
  meta?: Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════════════
// Persona
// ══════════════════════════════════════════════════════════════════════

export type PersonaTier = 'default' | 'standard' | 'sensitive' | 'locked';

export interface PersonaDetail {
  id: string;
  name: string;
  tier: PersonaTier;
  locked: boolean;
  description?: string;
}

// ══════════════════════════════════════════════════════════════════════
// Reminder
// ══════════════════════════════════════════════════════════════════════

export interface ReminderInput {
  /** `""` for one-time, recurrence expression otherwise. */
  type: string;
  message: string;
  /** Unix seconds when the reminder should fire. */
  triggerAt: number;
  persona: string;
  /** Free-form category. */
  kind: string;
  /** Source vault item id, if derived from one. */
  sourceItemId?: string;
  /** Source tag (gmail/d2d/manual). */
  source?: string;
  /** Stringified JSON for provider-specific metadata. */
  metadata?: string;
}

// ══════════════════════════════════════════════════════════════════════
// Outcome types
// ══════════════════════════════════════════════════════════════════════

export type CoreClientErrorCode =
  | 'unauthorized'
  | 'persona_locked'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_input'
  | 'core_error'
  | 'network_error';

export interface CoreClientError {
  code: CoreClientErrorCode;
  message: string;
  status?: number;
}

export type CoreOutcome<T> = { ok: true; value: T } | { ok: false; error: CoreClientError };

// ══════════════════════════════════════════════════════════════════════
// CoreClient interface
// ══════════════════════════════════════════════════════════════════════

/**
 * The canonical Brain→Core interface. Every Brain handler imports
 * this type; every concrete impl (HTTP / in-process / mock) implements it.
 */
export interface CoreClient {
  /** Vault: hybrid / fts5 / semantic search. */
  queryVault(input: VaultQueryInput): Promise<CoreOutcome<VaultItem[]>>;

  /** Vault: persist an item. Returns the assigned id. */
  storeVault(input: VaultStoreInput): Promise<CoreOutcome<{ id: string }>>;

  /** PII: scrub text with the configured tier (Tier 1 regex / Tier 2 Presidio). */
  scrubPii(input: PiiScrubInput): Promise<CoreOutcome<PiiScrubResult>>;

  /**
   * Deliver a notification. Core fans out to any paired WebSocket
   * clients + the platform notifier (e.g. APNs/FCM in mobile).
   */
  notify(input: NotifyInput): Promise<CoreOutcome<void>>;

  /** List installed personas with tier + lock state. */
  listPersonas(): Promise<CoreOutcome<PersonaDetail[]>>;

  /** Write a reminder. Returns the assigned id. */
  storeReminder(input: ReminderInput): Promise<CoreOutcome<{ id: string }>>;

  /**
   * Optional: write a scratchpad checkpoint (task 5.42). The Core
   * scratchpad endpoint auto-expires entries at 24h.
   */
  writeScratchpad(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<CoreOutcome<void>>;

  /** Optional: read the latest scratchpad checkpoint for a task. */
  readScratchpad(
    taskId: string,
  ): Promise<CoreOutcome<{ step: number; context: Record<string, unknown> } | null>>;
}

// ══════════════════════════════════════════════════════════════════════
// NullCoreClient — test + local-dev reference
// ══════════════════════════════════════════════════════════════════════

export interface NullCoreClientOptions {
  /** When provided, every call records a history entry. */
  recordCalls?: boolean;
  /** Default personas returned by listPersonas. */
  defaultPersonas?: PersonaDetail[];
}

export interface NullCoreCall {
  method: keyof CoreClient;
  input: unknown;
}

const DEFAULT_NULL_PERSONAS: PersonaDetail[] = [
  { id: 'persona-general', name: 'general', tier: 'default', locked: false },
];

/**
 * A null-adapter implementation that returns empty / default
 * values for every method. Tests that don't exercise a specific
 * Core surface can pass one of these to Brain primitives without
 * scripting per-call stubs.
 *
 * Use `recordCalls: true` to capture the call sequence for
 * assertions.
 */
export class NullCoreClient implements CoreClient {
  private readonly _calls: NullCoreCall[] = [];
  private readonly shouldRecord: boolean;
  private readonly defaultPersonas: PersonaDetail[];

  constructor(opts: NullCoreClientOptions = {}) {
    this.shouldRecord = opts.recordCalls === true;
    this.defaultPersonas = opts.defaultPersonas ?? DEFAULT_NULL_PERSONAS;
  }

  get calls(): ReadonlyArray<NullCoreCall> {
    // Shallow copy so external callers mutating the view (pushing,
    // splicing) can't corrupt internal history.
    return [...this._calls];
  }

  reset(): void {
    this._calls.length = 0;
  }

  async queryVault(input: VaultQueryInput): Promise<CoreOutcome<VaultItem[]>> {
    this.record('queryVault', input);
    return { ok: true, value: [] };
  }

  async storeVault(input: VaultStoreInput): Promise<CoreOutcome<{ id: string }>> {
    this.record('storeVault', input);
    const suppliedId = input.item.id;
    return {
      ok: true,
      value: { id: typeof suppliedId === 'string' && suppliedId !== '' ? suppliedId : 'null-core-id' },
    };
  }

  async scrubPii(input: PiiScrubInput): Promise<CoreOutcome<PiiScrubResult>> {
    this.record('scrubPii', input);
    return {
      ok: true,
      value: {
        scrubbedText: input.text,
        entityMap: {},
        counts: {},
      },
    };
  }

  async notify(input: NotifyInput): Promise<CoreOutcome<void>> {
    this.record('notify', input);
    return { ok: true, value: undefined };
  }

  async listPersonas(): Promise<CoreOutcome<PersonaDetail[]>> {
    this.record('listPersonas', undefined);
    return { ok: true, value: this.defaultPersonas.map((p) => ({ ...p })) };
  }

  async storeReminder(input: ReminderInput): Promise<CoreOutcome<{ id: string }>> {
    this.record('storeReminder', input);
    return { ok: true, value: { id: 'null-reminder-id' } };
  }

  async writeScratchpad(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
  ): Promise<CoreOutcome<void>> {
    this.record('writeScratchpad', { taskId, step, context });
    return { ok: true, value: undefined };
  }

  async readScratchpad(
    taskId: string,
  ): Promise<CoreOutcome<{ step: number; context: Record<string, unknown> } | null>> {
    this.record('readScratchpad', { taskId });
    return { ok: true, value: null };
  }

  private record(method: keyof CoreClient, input: unknown): void {
    if (this.shouldRecord) this._calls.push({ method, input });
  }
}
