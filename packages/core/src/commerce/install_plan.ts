import { BUYER_REFERENCE_MANIFEST, SUPPLIER_REFERENCE_MANIFEST } from './reference_manifests';

import type { PluginManifest } from '@dina/protocol';

/**
 * The Commerce Pack install journey (§18.1, FR-P1 — WS-7.1).
 *
 * The marketplace offers one pack and three choices: buy, sell, or both. §18.1
 * is explicit about what "both" means, and it is the whole item:
 *
 *   "Both" creates two installs/consent decisions, not one superset install.
 *
 * WHY THAT SENTENCE IS A SAFETY RULE AND NOT A UX PREFERENCE. A superset
 * install would give one consent record authority over both sides of a trade.
 * Revoking selling would then mean revoking buying; a compromise of the
 * supplier runner would carry buyer authority with it; and an owner reviewing
 * "what did I agree to" would read one list covering two businesses. Two
 * installs keep those separable, which is what FR-P1 asks for.
 *
 * THIS PLANS; IT DOES NOT INSTALL. The install machinery already exists
 * (`plugins/install_service.ts`) and owns repo proofs, pending expiry and
 * activation. What was missing is the step before it: turning a human choice
 * into the right NUMBER of installs, with the right manifest on each, and
 * refusing a plan that would blur them.
 */

export type CommerceRole = 'buyer' | 'supplier';
export type InstallChoice = 'buy' | 'sell' | 'both';

export interface PlannedInstall {
  role: CommerceRole;
  manifest: PluginManifest;
  /**
   * One consent decision per install, never shared.
   *
   * A label rather than a record id, because the record does not exist until
   * the owner decides. What matters here is that the plan carries TWO of them
   * when the choice is "both" — a plan with one consent covering two installs
   * is the superset install wearing a different shape.
   */
  consentLabel: string;
}

export type InstallPlanRefusal =
  /** A plan whose installs share a manifest — the superset in disguise. */
  | 'shared_manifest'
  /** A role's manifest carries a capability belonging to the other side. */
  | 'capability_crosses_roles'
  /** "Both" produced fewer than two installs. */
  | 'both_collapsed_to_one';

export interface InstallPlanFinding {
  refusal: InstallPlanRefusal;
  detail: string;
}

export type InstallPlan =
  | { ok: true; installs: PlannedInstall[] }
  | { ok: false; findings: InstallPlanFinding[] };

const MANIFEST_BY_ROLE: Readonly<Record<CommerceRole, PluginManifest>> = {
  buyer: BUYER_REFERENCE_MANIFEST,
  supplier: SUPPLIER_REFERENCE_MANIFEST,
};

const ROLES_BY_CHOICE: Readonly<Record<InstallChoice, CommerceRole[]>> = {
  buy: ['buyer'],
  sell: ['supplier'],
  // TWO entries, and the plan below is checked to make sure it stays two.
  both: ['buyer', 'supplier'],
};

/**
 * Turn the owner's choice into installs.
 *
 * The refusals here are all about one thing: a plan that would let one consent
 * decision cover both sides of a trade. They are checked rather than assumed
 * because the manifests are data — a pack author editing one could give the
 * buyer manifest an `order_status` capability, and nothing else in the system
 * would notice that a buyer install had gained a supplier's answer.
 */
export function planCommerceInstall(choice: InstallChoice): InstallPlan {
  const roles = ROLES_BY_CHOICE[choice];
  const findings: InstallPlanFinding[] = [];

  const installs: PlannedInstall[] = roles.map((role) => ({
    role,
    manifest: MANIFEST_BY_ROLE[role],
    consentLabel: `commerce:${role}`,
  }));

  if (choice === 'both' && installs.length < 2) {
    findings.push({
      refusal: 'both_collapsed_to_one',
      detail: '"Both" must produce two installs and two consent decisions (§18.1)',
    });
  }

  const manifestIds = new Set(installs.map((install) => install.manifest.plugin_id));
  if (manifestIds.size !== installs.length) {
    // The superset install in disguise: two roles, one manifest, therefore one
    // capability set and — in practice — one consent decision.
    findings.push({
      refusal: 'shared_manifest',
      detail: 'each role installs its own manifest; a shared one is a superset install',
    });
  }

  const crossing = capabilitiesCrossingRoles();
  if (crossing.length > 0) {
    findings.push({
      refusal: 'capability_crosses_roles',
      detail: `a manifest carries the other role's capability: ${crossing.join(', ')}`,
    });
  }

  return findings.length === 0 ? { ok: true, installs } : { ok: false, findings };
}

/**
 * Capabilities that appear in BOTH reference manifests.
 *
 * Checked rather than assumed. The manifests are data a pack author edits, and
 * an overlap is exactly the change that would silently give a buyer install a
 * supplier's authority — the thing separate installs exist to prevent.
 */
function capabilitiesCrossingRoles(): string[] {
  const buyer = new Set(BUYER_REFERENCE_MANIFEST.capabilities.map((c) => c.id));
  return SUPPLIER_REFERENCE_MANIFEST.capabilities
    .map((c) => c.id)
    .filter((id) => buyer.has(id))
    .sort();
}

/**
 * Does this set of active installs authorize the role?
 *
 * The read side of the same rule. A caller asking "may this node sell?" must
 * not be able to answer it from the presence of ANY commerce install — which
 * is precisely the shortcut a superset install would have made correct, and
 * which stays wrong here.
 */
export function roleIsInstalled(
  activeInstalls: { pluginId: string }[],
  role: CommerceRole,
): boolean {
  const wanted = MANIFEST_BY_ROLE[role].plugin_id;
  return activeInstalls.some((install) => install.pluginId === wanted);
}
