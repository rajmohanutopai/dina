/**
 * Task 5.24 — router model selection per task type.
 *
 * Given a task classification (reasoning, summarisation, classification,
 * embedding, chat) + a persona tier, pick the `(provider, model)` the
 * Brain should call. The router's job is to consume:
 *
 *   - `ProviderConfig` (task 5.23) — what's available
 *   - `CloudGate` (task 5.25) — what's permitted for this persona
 *   - `TaskRoutingPolicy` — per-task-type preference lists
 *
 * ...and produce a single `(provider, model)` pick. When NONE of the
 * preferred providers pass the gate (e.g. sensitive persona + no
 * local LLM configured), the router returns a structured rejection
 * so the ask handler (5.17) can fail cleanly.
 *
 * **Per-task-type preferences**: production wires these from config.
 * Each task type has a ranked provider list; for each provider, an
 * optional model override (falls back to the provider's
 * `defaultModel`). The router walks the preferences and picks the
 * FIRST provider that (a) is in the available list, (b) passes the
 * cloud gate for the target persona tier.
 *
 * **Why model-override is per-preference-entry**: a task like
 * `reasoning` may prefer "use Anthropic's best model", while
 * `classification` may prefer "use OpenAI's cheap model". Letting
 * the preference list specify the model keeps routing intent local
 * to the policy, not buried in provider config.
 *
 * **Separation from adapters**: this module returns a selection
 * (`{provider, model}`), not an LLM call. The caller (router + ask
 * handler) then invokes the matching provider adapter. Keeps the
 * policy testable without spinning up HTTP clients.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.24.
 */

import type { PersonaTier } from '@dina/core';
import type { CloudGate } from './cloud_gate';
import type { ProviderConfig, ProviderEntry } from './provider_config';
import { availableProviders } from './provider_config';

/** Task types Brain routes for. Open set; extend per use case. */
export type TaskType =
  | 'reasoning'
  | 'summarisation'
  | 'classification'
  | 'embedding'
  | 'chat';

export interface TaskPreference {
  /** Provider name (must match a registered `ProviderEntry.name`). */
  provider: string;
  /** Model override; falls back to the provider's `defaultModel`. */
  model?: string;
}

export type TaskRoutingPolicy = Readonly<Record<TaskType, TaskPreference[]>>;

export interface RouteSelection {
  provider: string;
  model: string;
  kind: 'cloud' | 'local';
}

export type RouteRejection =
  | { reason: 'no_preferences_for_task'; taskType: TaskType }
  | {
      reason: 'all_preferences_rejected';
      taskType: TaskType;
      attempts: Array<{
        provider: string;
        reason:
          | 'not_available'
          | 'not_registered_in_gate'
          | 'cloud_blocked'
          | 'model_not_in_provider';
      }>;
    };

export type RouteResult =
  | { ok: true; selection: RouteSelection }
  | { ok: false; rejection: RouteRejection };

export interface ModelRouterOptions {
  config: ProviderConfig;
  gate: CloudGate;
  policy: TaskRoutingPolicy;
}

export class ModelRouter {
  private readonly policy: TaskRoutingPolicy;
  private readonly gate: CloudGate;
  /** Cached set of names + models from `availableProviders`. Recomputed on demand when caller re-invokes `route` — no per-call reload needed since `ProviderConfig` is immutable after boot. */
  private readonly available: Map<string, ProviderEntry>;

  constructor(opts: ModelRouterOptions) {
    if (!opts.config) throw new Error('ModelRouter: config is required');
    if (!opts.gate) throw new Error('ModelRouter: gate is required');
    if (!opts.policy) throw new Error('ModelRouter: policy is required');
    this.policy = opts.policy;
    this.gate = opts.gate;
    this.available = new Map();
    for (const p of availableProviders(opts.config)) {
      this.available.set(p.name, p);
    }
  }

  /**
   * Pick a `(provider, model)` for a task+persona pair. Returns
   * structured result — the handler decides how to surface a
   * `no-preferences` or `all-rejected` failure (typically → fail the
   * ask with `reason: 'no_llm_available'`).
   */
  route(taskType: TaskType, personaTier: PersonaTier): RouteResult {
    const prefs = this.policy[taskType];
    if (!prefs || prefs.length === 0) {
      return {
        ok: false,
        rejection: { reason: 'no_preferences_for_task', taskType },
      };
    }

    const attempts: Array<{
      provider: string;
      reason:
        | 'not_available'
        | 'not_registered_in_gate'
        | 'cloud_blocked'
        | 'model_not_in_provider';
    }> = [];

    for (const pref of prefs) {
      const provider = this.available.get(pref.provider);
      if (provider === undefined) {
        attempts.push({ provider: pref.provider, reason: 'not_available' });
        continue;
      }
      const gateResult = this.gate.check(pref.provider, personaTier);
      if (!gateResult.ok) {
        attempts.push({
          provider: pref.provider,
          reason:
            gateResult.reason === 'unknown_provider'
              ? 'not_registered_in_gate'
              : 'cloud_blocked',
        });
        continue;
      }
      const model = pref.model ?? provider.defaultModel;
      if (!provider.models.includes(model)) {
        attempts.push({
          provider: pref.provider,
          reason: 'model_not_in_provider',
        });
        continue;
      }
      return {
        ok: true,
        selection: {
          provider: pref.provider,
          model,
          kind: gateResult.kind,
        },
      };
    }

    return {
      ok: false,
      rejection: { reason: 'all_preferences_rejected', taskType, attempts },
    };
  }
}
