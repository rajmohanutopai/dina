/**
 * MockCoreClient — test double for the `CoreClient` transport-agnostic
 * interface defined in `@dina/core`.
 *
 * Brain tests (Phase 1c task 1.35) that used to depend on the legacy
 * `BrainCoreClient` class (full HTTP stack + signing) now depend on
 * `CoreClient`. Real Brain code gets `InProcessTransport` on mobile
 * and `HttpCoreTransport` on server; Brain tests get `MockCoreClient`
 * here — zero I/O, zero crypto, call-recording + configurable canned
 * responses per method.
 *
 * Pattern matches the rest of `@dina/test-harness/src/mocks/`:
 *   - Public mutable fields for tests to configure response payloads.
 *   - `calls: RecordedCall[]` captures every invocation for assertions.
 *   - `throwOn: Record<methodName, Error>` injects failures per-method.
 *
 * For richer behavior (per-persona vault results, per-queryId service
 * responses), tests subclass this and override the method they need.
 * The base class stays dumb on purpose — it's a stub, not a simulator.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1c task 1.34.
 */

import type {
  CoreClient,
  CoreHealth,
  VaultQuery,
  VaultQueryResult,
  VaultItemInput,
  VaultStoreResult,
  VaultListOptions,
  VaultListResult,
  VaultDeleteResult,
  SignResult,
  CanonicalSignRequest,
  SignedHeaders,
  PIIScrubResult,
  PIIRehydrateResult,
  NotifyRequest,
  NotifyResult,
  PersonaStatusResult,
  PersonaUnlockResult,
  ServiceConfig,
  ServiceQueryClientRequest,
  ServiceQueryResult,
  MemoryToCOptions,
  MemoryToCResult,
} from '@dina/core';

/** One captured call — method name + positional args passed. */
export interface RecordedCall {
  method: keyof CoreClient;
  args: unknown[];
}

/**
 * Identifies the 14 methods on CoreClient that can have `throwOn` entries.
 * Using a narrow union (not `string`) makes typos fail compile.
 */
export type CoreClientMethodName = keyof CoreClient;

export class MockCoreClient implements CoreClient {
  /** Every call the mock has seen, in order. Cleared by `reset()`. */
  readonly calls: RecordedCall[] = [];

  /** When `throwOn[method]` is set, the mock throws that Error instead
   *  of returning. Use for exercising error-path code without needing
   *  a subclass. */
  throwOn: Partial<Record<CoreClientMethodName, Error>> = {};

  // ─── Canned responses ─────────────────────────────────────────────────
  // Tests mutate these before the method-under-test runs.

  healthResult: CoreHealth = {
    status: 'ok',
    did: 'did:key:mock-core',
    version: '0.0.0-test',
  };
  vaultQueryResult: VaultQueryResult = { items: [], count: 0 };
  vaultStoreResult: VaultStoreResult = {
    id: 'mock-item-id',
    storedAt: '2026-04-21T00:00:00Z',
  };
  vaultListResult: VaultListResult = { items: [], count: 0, total: 0 };
  vaultDeleteResult: VaultDeleteResult = { deleted: true };
  signResult: SignResult = { signature: 'mock-signature', did: 'did:key:mock-core' };
  canonicalSignResult: SignedHeaders = {
    did: 'did:key:mock-core',
    timestamp: '2026-04-21T12:00:00Z',
    nonce: 'mock-nonce-hex0',
    signature: 'mock-canonical-signature',
  };
  piiScrubResult: PIIScrubResult = {
    scrubbed: '',
    sessionId: 'mock-pii-session',
    entityCount: 0,
  };
  piiRehydrateResult: PIIRehydrateResult = {
    rehydrated: '',
    sessionFound: true,
  };
  notifyResult: NotifyResult = {
    accepted: true,
    notificationId: 'mock-notif-id',
    subscribers: 1,
  };
  personaStatusResult: PersonaStatusResult = {
    persona: 'personal',
    tier: 'default',
    open: true,
    dekFingerprint: 'mockfp12',
    openedAt: 1776700000,
  };
  personaUnlockResult: PersonaUnlockResult = {
    persona: 'financial',
    unlocked: true,
    dekFingerprint: 'mockfpAB',
  };
  serviceConfigResult: ServiceConfig | null = null;
  serviceQueryResult: ServiceQueryResult = {
    taskId: 'mock-task-id',
    queryId: 'mock-query-id',
  };
  memoryToCResult: MemoryToCResult = { entries: [], limit: 50 };

  /**
   * Per-persona override for `personaStatus`. When a tested code path
   * needs different tiers per persona (common for gatekeeper tests),
   * populate this map; unmatched personas fall back to `personaStatusResult`.
   */
  personaStatusByName: Record<string, PersonaStatusResult> = {};

  /** Drop all recorded calls + re-empty the override maps. */
  reset(): void {
    this.calls.length = 0;
    this.throwOn = {};
    this.personaStatusByName = {};
  }

  /** Count how many times a given method was called. */
  callCountOf(method: CoreClientMethodName): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  // ─── CoreClient implementation ────────────────────────────────────────

  async healthz(): Promise<CoreHealth> {
    return this.dispatch('healthz', [], () => this.healthResult);
  }

  async vaultQuery(persona: string, query: VaultQuery): Promise<VaultQueryResult> {
    return this.dispatch('vaultQuery', [persona, query], () => this.vaultQueryResult);
  }

  async vaultStore(persona: string, item: VaultItemInput): Promise<VaultStoreResult> {
    return this.dispatch('vaultStore', [persona, item], () => this.vaultStoreResult);
  }

  async vaultList(persona: string, opts?: VaultListOptions): Promise<VaultListResult> {
    return this.dispatch('vaultList', [persona, opts], () => this.vaultListResult);
  }

  async vaultDelete(persona: string, itemId: string): Promise<VaultDeleteResult> {
    return this.dispatch('vaultDelete', [persona, itemId], () => this.vaultDeleteResult);
  }

  async didSign(payload: Uint8Array): Promise<SignResult> {
    return this.dispatch('didSign', [payload], () => this.signResult);
  }

  async didSignCanonical(req: CanonicalSignRequest): Promise<SignedHeaders> {
    return this.dispatch('didSignCanonical', [req], () => this.canonicalSignResult);
  }

  async piiScrub(text: string): Promise<PIIScrubResult> {
    return this.dispatch('piiScrub', [text], () => {
      // Pass-through default: if the test hasn't configured a custom
      // scrubbed string, echo the input so downstream prompts receive
      // intelligible text. Matches MockBrainClient's convention.
      if (this.piiScrubResult.scrubbed === '') {
        return { ...this.piiScrubResult, scrubbed: text };
      }
      return this.piiScrubResult;
    });
  }

  async piiRehydrate(sessionId: string, text: string): Promise<PIIRehydrateResult> {
    return this.dispatch('piiRehydrate', [sessionId, text], () => {
      // Pass-through default — mirrors piiScrub.
      if (this.piiRehydrateResult.rehydrated === '') {
        return { ...this.piiRehydrateResult, rehydrated: text };
      }
      return this.piiRehydrateResult;
    });
  }

  async notify(notification: NotifyRequest): Promise<NotifyResult> {
    return this.dispatch('notify', [notification], () => this.notifyResult);
  }

  async personaStatus(persona: string): Promise<PersonaStatusResult> {
    return this.dispatch('personaStatus', [persona], () => {
      const override = this.personaStatusByName[persona];
      if (override !== undefined) return override;
      return { ...this.personaStatusResult, persona };
    });
  }

  async personaUnlock(persona: string, passphrase: string): Promise<PersonaUnlockResult> {
    return this.dispatch('personaUnlock', [persona, passphrase], () => ({
      ...this.personaUnlockResult,
      persona,
    }));
  }

  async serviceConfig(): Promise<ServiceConfig | null> {
    return this.dispatch('serviceConfig', [], () => this.serviceConfigResult);
  }

  async serviceQuery(req: ServiceQueryClientRequest): Promise<ServiceQueryResult> {
    return this.dispatch('serviceQuery', [req], () => ({
      ...this.serviceQueryResult,
      queryId: req.queryId,
    }));
  }

  async memoryToC(opts?: MemoryToCOptions): Promise<MemoryToCResult> {
    return this.dispatch('memoryToC', [opts], () => this.memoryToCResult);
  }

  // ─── Private ──────────────────────────────────────────────────────────

  /**
   * Record the call + throw-or-return. Centralised so every method
   * has identical behavior (call logging comes FIRST even on the
   * throw path — tests asserting "throw still logged the attempt"
   * can see it).
   */
  private async dispatch<T>(
    method: CoreClientMethodName,
    args: unknown[],
    produce: () => T,
  ): Promise<T> {
    this.calls.push({ method, args });
    const injected = this.throwOn[method];
    if (injected !== undefined) throw injected;
    return produce();
  }
}
