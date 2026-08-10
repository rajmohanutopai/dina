/**
 * §15.2 — the install facts an approval binds come from CORE, not the caller
 * (DR-2).
 *
 * THE DEFECT THIS CLOSES. `POST /v1/commerce/orders/prepare` took the whole
 * `BuyerApprovalContext` verbatim out of the request body and retained it, and
 * §15.2's last line — "plugin install, capability, manifest CID, scope hash,
 * and config revision" — was therefore bound to whatever the caller said those
 * were. The §15.2 binding then compared the send against the retained card and
 * agreed with itself, because both halves came from the same claim.
 *
 * WHY THAT MATTERS EVEN ON AN OWNER-ONLY ROUTE. The point of binding the
 * install is that the owner approved an order that a PARTICULAR pack, at a
 * particular manifest and a particular config revision, was about to place. A
 * card naming an install that does not exist, is paused, holds no such
 * capability, or has since had its config changed, binds nothing an auditor
 * could check afterwards. It is the same confused-deputy shape as trusting a
 * D2D inner body: a field is authority only when the party that produced it is
 * the party being bound.
 *
 * DISAGREEMENT IS A REFUSAL, NEVER AN OVERWRITE. Where the body names a
 * manifest CID, scope hash or config revision that differs from the registry's,
 * this refuses rather than quietly substituting the true value. The surface
 * showed the owner something; if it disagrees with what would actually run, the
 * owner approved a description of a different act, and silently correcting it
 * would mean the card and the send agree while the human and the card do not.
 *
 * NOT A VALIDATION HELPER. It RESOLVES. The returned context is the one that
 * gets retained and digested, so every field §15.2 names about the install has
 * a single origin: this node's own registry.
 */

import { getPluginInstallRepository } from '../plugins/registry';

import type { BuyerApprovalContext } from './approval_payload';

/** Why an acting install could not be resolved. Each is a distinct refusal. */
export type ActingInstallRefusal =
  | 'install_registry_unavailable'
  | 'acting_install_missing'
  | 'unknown_install'
  | 'install_not_active'
  | 'capability_not_held'
  | 'install_facts_disagree'
  /** §7.1 role separation — the named install is not the pack for this side. */
  | 'wrong_pack_role';

export type ResolvedActingInstall =
  | { ok: true; context: BuyerApprovalContext }
  | { ok: false; refusal: ActingInstallRefusal; detail: string };

/**
 * Replace the caller's install claim with this node's own record of it.
 *
 * `installId` and `capabilityId` are SELECTORS — the surface saying which
 * install it is acting under and which of that install's capabilities it is
 * using. Everything else about the install is read from the registry.
 */
export function resolveActingInstall(
  context: BuyerApprovalContext,
  /**
   * §7.1 — WHICH PACK may act on this side. Both selectors come out of a
   * request body, so without this an owner surface could bind the SUPPLIER
   * install (or any unrelated active plugin) as the pack that placed a
   * purchase order, and both the §15.2 record and the §7.2 chain would name
   * it. WS-7.1's DoD calls role separation "a SAFETY rule and not a UX
   * preference" — a compromise of the supplier runner must not carry buyer
   * authority with it.
   *
   * `roleIsInstalled` already expressed this rule and had no production caller
   * for the buyer side, which is the same defect class as the rest of this
   * round.
   */
  expectedPluginId: string,
): ResolvedActingInstall {
  const claimed = context.install;
  if (
    claimed === undefined ||
    typeof claimed.installId !== 'string' ||
    claimed.installId === '' ||
    typeof claimed.capabilityId !== 'string' ||
    claimed.capabilityId === ''
  ) {
    return {
      ok: false,
      refusal: 'acting_install_missing',
      detail: 'context.install must name installId and capabilityId',
    };
  }

  const repo = getPluginInstallRepository();
  if (repo === null) {
    // A node that cannot read its own install registry cannot say what is
    // about to act, so it does not let anything act. Distinct from "no such
    // install": one is a broken node, the other is a bad request.
    return {
      ok: false,
      refusal: 'install_registry_unavailable',
      detail: 'no plugin install repository is installed on this node',
    };
  }

  const install = repo.getById(claimed.installId);
  if (install === null) {
    return {
      ok: false,
      refusal: 'unknown_install',
      detail: `no install ${claimed.installId} on this node`,
    };
  }
  if (install.status !== 'active') {
    // Pending, paused and revoked all mean the same thing here: this pack is
    // not permitted to act right now, so an approval must not be minted that
    // says it did.
    return {
      ok: false,
      refusal: 'install_not_active',
      detail: `install ${claimed.installId} is ${install.status}`,
    };
  }

  if (install.pluginId !== expectedPluginId) {
    return {
      ok: false,
      refusal: 'wrong_pack_role',
      detail: `install ${claimed.installId} is ${install.pluginId}, not ${expectedPluginId}`,
    };
  }

  const held = Object.prototype.hasOwnProperty.call(
    install.capabilityHashes,
    claimed.capabilityId,
  );
  if (!held) {
    return {
      ok: false,
      refusal: 'capability_not_held',
      detail: `install ${claimed.installId} holds no capability ${claimed.capabilityId}`,
    };
  }

  const truth = {
    installId: install.installId,
    capabilityId: claimed.capabilityId,
    manifestCid: install.currentCid,
    installScopeHash: install.installScopeHash,
    configRevision: String(install.configRevision),
  };

  // The body MAY carry these — a surface that rendered them has to have got
  // them from somewhere. What it may not do is differ. An absent field is a
  // surface that did not claim; a different field is a surface that is wrong
  // about what it showed the owner.
  const disagreements: string[] = [];
  for (const field of ['manifestCid', 'installScopeHash', 'configRevision'] as const) {
    const stated = claimed[field];
    if (stated !== undefined && stated !== '' && stated !== truth[field]) {
      disagreements.push(`${field}: card says ${stated}, node says ${truth[field]}`);
    }
  }
  if (disagreements.length > 0) {
    return {
      ok: false,
      refusal: 'install_facts_disagree',
      detail: disagreements.join('; '),
    };
  }

  return { ok: true, context: { ...context, install: truth } };
}
