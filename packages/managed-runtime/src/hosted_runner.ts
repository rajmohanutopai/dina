/**
 * Hosted plugin runner binding (§17.4).
 *
 * A vendor may run ONE process serving many businesses. §17.4 permits that and
 * then names its price: "every claim is bound to tenant, install ID, paired
 * plugin instance identity/certificate, exact plugin lane, capability and
 * manifest CID, claim token and context ticket, authority snapshot. A
 * vendor-wide identity alone cannot claim any tenant's task."
 *
 * WHERE THIS SITS RELATIVE TO CORE'S CLAIM GUARD. Core already enforces every
 * one of those bindings INSIDE a tenant: it forces the lane, matches the
 * install's paired device, checks the capability and manifest CID, and
 * terminalizes on a stale authority snapshot. That is the guard that actually
 * protects a tenant, and it must stay the last word — a hosting layer that
 * could vouch for a claim would be a way around it.
 *
 * So this adds the ONE binding a single Core cannot see: which tenants a
 * vendor identity is admitted to at all. A Core knows its own installs; it
 * cannot know that the same vendor DID is also serving a competitor, nor that
 * an operator has suspended the vendor fleet-wide. Both are control-plane
 * facts, and both fail CLOSED here before a claim is ever attempted.
 *
 * IT NARROWS AND NEVER WIDENS. `admits` returning true is not permission to
 * claim; it is permission to try. Core's guard then decides. Nothing here can
 * make a claim succeed that Core would refuse, which is the property that
 * keeps a compromised control plane from becoming a compromised tenant.
 */

/** One vendor identity's admission to one tenant's install. */
export interface RunnerBinding {
  /** The vendor's device DID — the identity that authenticates. */
  runnerDid: string;
  tenantId: string;
  /** The install inside that tenant this binding covers. */
  installId: string;
  /** False while an operator has suspended it; the row survives, revocable. */
  active: boolean;
}

export type BindingRefusal =
  /** This vendor identity is admitted to no tenant at all. */
  | 'unknown_runner'
  /** Admitted elsewhere, but not to the tenant being asked about. */
  | 'not_bound_to_tenant'
  /** Bound to the tenant, but not to that install. */
  | 'not_bound_to_install'
  /** Bound, and suspended. */
  | 'binding_suspended'
  /** The whole vendor fleet is suspended. */
  | 'fleet_suspended';

export type BindingVerdict = { ok: true } | { ok: false; refusal: BindingRefusal; detail: string };

export class HostedRunnerRegistry {
  private readonly bindings: RunnerBinding[] = [];
  private readonly suspendedFleets = new Set<string>();

  bind(binding: RunnerBinding): void {
    const existing = this.bindings.find(
      (b) =>
        b.runnerDid === binding.runnerDid &&
        b.tenantId === binding.tenantId &&
        b.installId === binding.installId,
    );
    if (existing !== undefined) {
      existing.active = binding.active;
      return;
    }
    this.bindings.push({ ...binding });
  }

  /**
   * Suspend an entire vendor fleet.
   *
   * ONE CALL, EVERY TENANT. The reason this exists as a fleet operation rather
   * than a loop over bindings: the moment a hosted runner is compromised, the
   * operator needs a stop that cannot half-apply. A loop that failed partway
   * would leave a subset of businesses being served by a runner the operator
   * had already decided was hostile.
   */
  suspendFleet(runnerDid: string): void {
    this.suspendedFleets.add(runnerDid);
  }

  resumeFleet(runnerDid: string): void {
    this.suspendedFleets.delete(runnerDid);
  }

  /**
   * May this vendor identity ATTEMPT a claim here?
   *
   * Fail-closed at every step, and the refusals are ordered from least to most
   * specific so an operator reading a log learns the least that is still true:
   * `unknown_runner` says nothing about which tenants exist, and
   * `not_bound_to_tenant` says nothing about which installs do.
   */
  admits(runnerDid: string, tenantId: string, installId: string): BindingVerdict {
    if (this.suspendedFleets.has(runnerDid)) {
      return { ok: false, refusal: 'fleet_suspended', detail: 'this runner fleet is suspended' };
    }
    const forRunner = this.bindings.filter((b) => b.runnerDid === runnerDid);
    if (forRunner.length === 0) {
      return { ok: false, refusal: 'unknown_runner', detail: 'no binding for this runner' };
    }
    const forTenant = forRunner.filter((b) => b.tenantId === tenantId);
    if (forTenant.length === 0) {
      // The §17.4 sentence, enforced: a vendor-wide identity, admitted
      // somewhere, is not thereby admitted here.
      return {
        ok: false,
        refusal: 'not_bound_to_tenant',
        detail: 'a vendor-wide identity is not a binding to this tenant (§17.4)',
      };
    }
    const exact = forTenant.find((b) => b.installId === installId);
    if (exact === undefined) {
      return {
        ok: false,
        refusal: 'not_bound_to_install',
        detail: 'bound to this tenant, but not to this install',
      };
    }
    if (!exact.active) {
      return { ok: false, refusal: 'binding_suspended', detail: 'this binding is suspended' };
    }
    return { ok: true };
  }

  /** Every tenant this runner may attempt, for an operator's console. */
  tenantsFor(runnerDid: string): string[] {
    if (this.suspendedFleets.has(runnerDid)) return [];
    return [
      ...new Set(
        this.bindings.filter((b) => b.runnerDid === runnerDid && b.active).map((b) => b.tenantId),
      ),
    ].sort();
  }
}
