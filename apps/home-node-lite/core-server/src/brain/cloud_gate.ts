/**
 * Task 5.25 — cloud gate: refuse cloud LLM for sensitive personas.
 *
 * A brain-side policy layer that sits between the LLM router (task
 * 5.24) and the provider adapters (5.22). For every request, the
 * router passes `{provider, persona}`; the gate returns `{ok, reason}`.
 * When a request targets a `sensitive` or `locked` persona AND the
 * provider is cloud-hosted, the gate refuses — the router must then
 * either fall back to a local provider (task 5.29) or fail.
 *
 * **Why at this layer** (not inside each provider): centralising the
 * policy means a new cloud provider added tomorrow inherits the same
 * gate without a per-adapter audit. The alternative (every cloud
 * adapter checks persona tier) drifts with every provider change
 * and has a class of "new adapter forgot the check" bugs.
 *
 * **Provider classification** is data, not code-branching: `{provider:
 * string, kind: 'cloud' | 'local'}`. The gate's `loadProviders`
 * accepts a list; production wires the Brain's provider config, tests
 * pass literal arrays. `cloud` is the only tier that's gated — `local`
 * providers (on-device llama, local-LLM at `localhost`) have no
 * outbound-data risk so they pass regardless of persona.
 *
 * **Persona tier source** is `@dina/core.PersonaTier`. The 4-tier
 * model (`default | standard | sensitive | locked` from CLAUDE.md
 * §Persona Access Tiers) is authoritative. Sensitive + locked are
 * both cloud-blocked; default + standard pass. Pinned by test.
 *
 * **Return contract**: structured result, not throw — the router
 * wants to log the rejection + try a local fallback, not catch an
 * exception.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.25.
 */

import type { PersonaTier } from '@dina/core';

export type ProviderKind = 'cloud' | 'local';

export interface ProviderEntry {
  /** Opaque provider name — "anthropic", "openai", "local-llama", etc. */
  readonly name: string;
  readonly kind: ProviderKind;
}

export type GateRejectionReason =
  | 'unknown_provider'
  | 'cloud_blocked_for_persona_tier';

export type GateResult =
  | { ok: true; kind: ProviderKind }
  | { ok: false; reason: GateRejectionReason; detail?: string };

export interface CloudGateOptions {
  providers: Iterable<ProviderEntry>;
}

/** Tiers whose content may NOT leave the Home Node. */
const CLOUD_BLOCKED_TIERS: ReadonlySet<PersonaTier> = new Set<PersonaTier>([
  'sensitive',
  'locked',
]);

/**
 * Policy that returns `{ok, reason}` for each `(provider, persona tier)`
 * pair. Stateless — loaded once at boot from the Brain config.
 */
export class CloudGate {
  private readonly providers = new Map<string, ProviderKind>();

  constructor(opts: CloudGateOptions) {
    if (!opts.providers) {
      throw new Error('CloudGate: providers is required');
    }
    for (const entry of opts.providers) {
      this.register(entry);
    }
  }

  /**
   * Add or replace a provider entry. Returns self for chaining in
   * tests that build a gate incrementally.
   */
  register(entry: ProviderEntry): this {
    if (!entry.name || entry.name.length === 0) {
      throw new Error('CloudGate.register: provider name is required');
    }
    if (entry.kind !== 'cloud' && entry.kind !== 'local') {
      throw new Error(
        `CloudGate.register: kind must be "cloud" or "local" (got ${JSON.stringify(entry.kind)})`,
      );
    }
    this.providers.set(entry.name, entry.kind);
    return this;
  }

  /**
   * Check whether this `(provider, persona tier)` pair is allowed.
   * Structured result so the router can log the rejection cleanly
   * AND retry with a local fallback without a throw/catch round trip.
   */
  check(providerName: string, personaTier: PersonaTier): GateResult {
    const kind = this.providers.get(providerName);
    if (kind === undefined) {
      return {
        ok: false,
        reason: 'unknown_provider',
        detail: `provider ${JSON.stringify(providerName)} is not registered`,
      };
    }
    if (kind === 'cloud' && CLOUD_BLOCKED_TIERS.has(personaTier)) {
      return {
        ok: false,
        reason: 'cloud_blocked_for_persona_tier',
        detail: `cloud providers are not permitted for ${personaTier}-tier personas`,
      };
    }
    return { ok: true, kind };
  }

  /**
   * Filter a provider preference list down to ones that pass the gate
   * for the given persona tier. Preserves order — callers typically
   * rank providers by preference (task 5.24), and the router picks
   * the first `ok` hit. Returns a new array.
   */
  filterAllowed(
    preferences: readonly string[],
    personaTier: PersonaTier,
  ): string[] {
    const out: string[] = [];
    for (const name of preferences) {
      if (this.check(name, personaTier).ok) out.push(name);
    }
    return out;
  }

  /** Number of registered providers. */
  size(): number {
    return this.providers.size;
  }

  /** True iff this provider is known to the gate. */
  has(providerName: string): boolean {
    return this.providers.has(providerName);
  }

  /**
   * Snapshot the registered providers — useful for /readyz or
   * admin-UI render. Returns a new array; mutation doesn't affect
   * the gate.
   */
  list(): ProviderEntry[] {
    return Array.from(this.providers, ([name, kind]) => ({ name, kind })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  }
}
