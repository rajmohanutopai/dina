/**
 * Task 5.43 — multi-provider LLM routing decision tree.
 *
 * Given (taskType, personaTier, availableProviders, userConsent), the
 * router returns a single `RoutingDecision` — which provider to use
 * and what treatment the request needs. It does **NOT** invoke any
 * LLM — the decision is consumed by a caller who wires the actual
 * provider call (+ Entity Vault scrubbing if the decision requires).
 *
 * **Relationship to 5.24 (`ModelRouter`)**:
 *   - `ModelRouter` maps `(taskType, personaTier) → modelName` at the
 *     per-provider level ("anthropic:claude-haiku-4-5" vs
 *     "anthropic:claude-opus-4-7").
 *   - `LlmRouter` (this module) is one level up: "should this even
 *     go to an LLM, and if so local vs cloud". The caller composes
 *     them — LlmRouter decides the lane; ModelRouter picks the
 *     model within the lane.
 *
 * **Decision tree** (pinned by tests):
 *
 *   1. **FTS-only tasks** (`fts_lookup`, `keyword_search`): no LLM,
 *      action='fts_only'. Return immediately — no provider needed.
 *   2. **Locked personas** + cloud-only provider available → REFUSE.
 *      Cloud route is permanently blocked for locked content (this
 *      is the CloudGate contract from 5.25, mirrored here).
 *   3. **Sensitive personas**: prefer local when available; cloud
 *      requires `userConsent === true` AND 'share-pii' context
 *      adjustments on the scrubbing layer (callers use EntityVault
 *      from 5.34).
 *   4. **Default / standard personas**: user's `preferredProvider`
 *      wins if present and available; otherwise prefer local for
 *      speed + privacy; fall back to any cloud provider.
 *   5. **No providers at all** → REFUSE with `no_providers`.
 *   6. **Lightweight tasks** (classification, summarisation, intent)
 *      prefer local even when cloud is requested by preference —
 *      local is fast + sufficient for 90% of calls.
 *
 * **Pure + synchronous** — no network, no clock. Tests exercise the
 * full tree.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.43.
 */

/** Types of LLM work callers may submit. */
export type LlmTaskType =
  | 'fts_lookup'
  | 'keyword_search'
  | 'intent_classification'
  | 'domain_classification'
  | 'summarize'
  | 'guard_scan'
  | 'silence_classify'
  | 'multi_step'
  | 'complex_reasoning'
  | 'deep_analysis'
  | 'video_analysis';

export type PersonaTier = 'default' | 'standard' | 'sensitive' | 'locked';

/** Descriptor for an available provider — the router consumes only what it needs. */
export interface ProviderDescriptor {
  /** Unique id. Free-form — `"local"`, `"anthropic"`, `"gemini"`, etc. */
  id: string;
  /** True when the provider runs on-device (no data leaves the Home Node). */
  isLocal: boolean;
  /** Descriptive name for UI/logs. */
  name?: string;
}

export interface RouteRequest {
  taskType: LlmTaskType;
  personaTier: PersonaTier;
  providers: ReadonlyArray<ProviderDescriptor>;
  /**
   * Whether the user has explicitly acknowledged cloud LLM consent
   * during setup. When false, cloud routes on sensitive personas are
   * refused.
   */
  userConsent: boolean;
  /**
   * Optional hint for which cloud provider the user prefers. If the
   * named provider isn't in `providers`, falls through to the first
   * available cloud.
   */
  preferredProvider?: string;
}

export type RoutingAction = 'fts_only' | 'local' | 'cloud' | 'refuse';

export type RouteRefusalReason =
  | 'no_providers'
  | 'locked_persona_cloud_only'
  | 'sensitive_persona_no_consent'
  | 'task_requires_cloud_but_unavailable';

export type RoutingDecision =
  | { action: 'fts_only'; reason: string }
  | {
      action: 'local';
      providerId: string;
      reason: string;
      requiresScrubbing: false;
    }
  | {
      action: 'cloud';
      providerId: string;
      reason: string;
      /** Always true for cloud routes — the caller MUST scrub via EntityVault. */
      requiresScrubbing: true;
    }
  | {
      action: 'refuse';
      reason: RouteRefusalReason;
      detail: string;
    };

const FTS_ONLY: ReadonlySet<LlmTaskType> = new Set([
  'fts_lookup',
  'keyword_search',
]);

/** 90% of tasks — fast + cheap, sufficient quality. Prefer local. */
const LIGHTWEIGHT: ReadonlySet<LlmTaskType> = new Set([
  'intent_classification',
  'domain_classification',
  'summarize',
  'guard_scan',
  'silence_classify',
  'multi_step',
]);

/** Require heavy-lift capability — prefer the best available model. */
const COMPLEX: ReadonlySet<LlmTaskType> = new Set([
  'complex_reasoning',
  'deep_analysis',
  'video_analysis',
]);

const SENSITIVE_TIERS: ReadonlySet<PersonaTier> = new Set([
  'sensitive',
  'locked',
]);

export interface LlmRouterOptions {
  /** Diagnostic hook. */
  onEvent?: (event: LlmRouterEvent) => void;
}

export type LlmRouterEvent =
  | { kind: 'routed'; action: RoutingAction; providerId?: string }
  | { kind: 'refused'; reason: RouteRefusalReason };

export class LlmRouter {
  private readonly onEvent?: (event: LlmRouterEvent) => void;

  constructor(opts: LlmRouterOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /**
   * Decide how to serve `req`. Pure — same request → same decision.
   * Never throws; invalid inputs surface as `refuse` with a detail
   * string.
   */
  route(req: RouteRequest): RoutingDecision {
    const { taskType, personaTier, providers, userConsent } = req;

    // 1. FTS-only short circuit — no LLM needed.
    if (FTS_ONLY.has(taskType)) {
      const d: RoutingDecision = {
        action: 'fts_only',
        reason: `taskType=${taskType} served without LLM`,
      };
      this.onEvent?.({ kind: 'routed', action: 'fts_only' });
      return d;
    }

    if (!Array.isArray(providers) || providers.length === 0) {
      const d: RoutingDecision = {
        action: 'refuse',
        reason: 'no_providers',
        detail: 'no providers configured',
      };
      this.onEvent?.({ kind: 'refused', reason: 'no_providers' });
      return d;
    }

    const locals = providers.filter((p) => p.isLocal === true);
    const clouds = providers.filter((p) => p.isLocal === false);

    // 2. Locked persona: cloud never allowed. Must have local.
    if (personaTier === 'locked') {
      if (locals.length === 0) {
        const d: RoutingDecision = {
          action: 'refuse',
          reason: 'locked_persona_cloud_only',
          detail: 'locked persona requires a local provider; none available',
        };
        this.onEvent?.({ kind: 'refused', reason: 'locked_persona_cloud_only' });
        return d;
      }
      return this.emitLocal(
        locals[0]!,
        'locked persona routed to local provider',
      );
    }

    // 3. Sensitive persona: prefer local; cloud only with consent.
    if (personaTier === 'sensitive') {
      if (locals.length > 0) {
        return this.emitLocal(
          locals[0]!,
          'sensitive persona routed to local provider',
        );
      }
      if (!userConsent) {
        const d: RoutingDecision = {
          action: 'refuse',
          reason: 'sensitive_persona_no_consent',
          detail:
            'sensitive persona has no local provider; cloud refused without user consent',
        };
        this.onEvent?.({ kind: 'refused', reason: 'sensitive_persona_no_consent' });
        return d;
      }
      return this.emitCloud(
        pickPreferredCloud(clouds, req.preferredProvider),
        'sensitive persona routed to consented cloud provider (scrubbing required)',
      );
    }

    // 4. Default / standard personas.
    //    Lightweight tasks prefer local when available.
    if (LIGHTWEIGHT.has(taskType) && locals.length > 0) {
      return this.emitLocal(locals[0]!, 'lightweight task routed to local');
    }

    //    Complex tasks prefer the best available — user's preferred
    //    cloud wins, else any cloud, else local.
    if (COMPLEX.has(taskType)) {
      if (clouds.length > 0) {
        return this.emitCloud(
          pickPreferredCloud(clouds, req.preferredProvider),
          'complex task routed to cloud',
        );
      }
      if (locals.length > 0) {
        return this.emitLocal(
          locals[0]!,
          'complex task: no cloud available, fall back to local',
        );
      }
      const d: RoutingDecision = {
        action: 'refuse',
        reason: 'task_requires_cloud_but_unavailable',
        detail: 'complex task needs an LLM provider; none available',
      };
      this.onEvent?.({ kind: 'refused', reason: 'task_requires_cloud_but_unavailable' });
      return d;
    }

    //    Any other default-tier task: user preference wins, then local, then cloud.
    const preferred = req.preferredProvider
      ? providers.find((p) => p.id === req.preferredProvider)
      : undefined;
    if (preferred) {
      return preferred.isLocal
        ? this.emitLocal(preferred, 'default tier routed to user-preferred local provider')
        : this.emitCloud(
            preferred,
            'default tier routed to user-preferred cloud provider',
          );
    }
    if (locals.length > 0) {
      return this.emitLocal(locals[0]!, 'default tier routed to local');
    }
    return this.emitCloud(clouds[0]!, 'default tier routed to cloud (no local available)');
  }

  // ── Internals ────────────────────────────────────────────────────────

  private emitLocal(p: ProviderDescriptor, reason: string): RoutingDecision {
    const d: RoutingDecision = {
      action: 'local',
      providerId: p.id,
      reason,
      requiresScrubbing: false,
    };
    this.onEvent?.({ kind: 'routed', action: 'local', providerId: p.id });
    return d;
  }

  private emitCloud(p: ProviderDescriptor, reason: string): RoutingDecision {
    const d: RoutingDecision = {
      action: 'cloud',
      providerId: p.id,
      reason,
      requiresScrubbing: true,
    };
    this.onEvent?.({ kind: 'routed', action: 'cloud', providerId: p.id });
    return d;
  }
}

function pickPreferredCloud(
  clouds: ReadonlyArray<ProviderDescriptor>,
  preferred: string | undefined,
): ProviderDescriptor {
  if (preferred) {
    const match = clouds.find((p) => p.id === preferred);
    if (match) return match;
  }
  return clouds[0]!; // caller ensures clouds.length > 0
}
