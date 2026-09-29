/**
 * Item 1 (NEGOTIATION follow-up) — Dina's own commerce and country packs
 * update IN PLACE, with the build. One module for the owner's three steps
 * (list, review, confirm) so the server route and the phone's in-process
 * Plugins screen do exactly the same thing, including binding the lanes a new
 * version adds to the supplier listing.
 */

import { getPluginInstallRepository, type PluginInstall } from '../plugins/registry';
import {
  confirmUpdate,
  prepareUpdateFromTrustedManifest,
  type ConfirmUpdateResult,
  type PrepareUpdateResult,
} from '../plugins/update_service';

import {
  FIRST_PARTY_MANIFESTS,
  KERNEL_REFERENCE_KEY_ID,
  isFirstPartyManifestId,
  referenceManifestCid,
} from './reference_install';
import { SUPPLIER_REFERENCE_MANIFEST } from './reference_manifests';
import { getCommerceRuntime } from './runtime';
import {
  bindSupplierListing,
  supplierListingNameFor,
  type SupplierListingOutcome,
} from './supplier_listing';

import type { WideningFinding } from '../plugins/update_widening';
import type { PluginManifest } from '@dina/protocol';

/**
 * Item 1 (NEGOTIATION follow-up) — a first-party pack UPDATES WITH THE BUILD.
 *
 * An install this build vouched for (`local_publisher_key`, the kernel key)
 * never takes bytes from a PDS; when the build ships a newer manifest for its
 * plugin id, that manifest is the update. It goes through the ordinary
 * two-step update — review (widening, behaviour change) then confirm — and the
 * same coordinator, which KEEPS THE INSTALL: open orders stay with it, the
 * previous contract is authorised for the work already in flight, and the
 * listings move to the new manifest. Retiring and reinstalling, the only path
 * before, is refused while orders are open (§16.4), so a pack with a paid
 * order could never gain a new lane.
 */
function buildManifestFor(
  install: PluginInstall,
): { manifest: PluginManifest; cid: string } | null {
  if (install.trustAnchor.kind !== 'local_publisher_key') return null;
  if (install.trustAnchor.keyId !== KERNEL_REFERENCE_KEY_ID) return null;
  if (!isFirstPartyManifestId(install.pluginId)) return null;
  const manifest: PluginManifest = FIRST_PARTY_MANIFESTS[install.pluginId];
  const cid = referenceManifestCid(manifest);
  // Forward only: a build OLDER than the install (a downgrade) offers nothing,
  // or it would walk the install back onto a contract it already left.
  if (cid === install.currentCid || !isNewerVersion(manifest.version, install.currentVersion)) {
    return null;
  }
  return { manifest, cid };
}

/** Dotted numeric versions, compared part by part; anything unreadable is not newer. */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const parts = v.split('.').map((p) => (/^\d{1,9}$/.test(p) ? Number(p) : NaN));
    return parts.some((n) => Number.isNaN(n)) ? null : parts;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export interface FirstPartyUpdate {
  installId: string;
  pluginId: string;
  displayName: string;
  fromVersion: string;
  toVersion: string;
}

/** Every active first-party install whose build ships a newer manifest. */
export function listFirstPartyUpdates(): FirstPartyUpdate[] {
  const installs = getPluginInstallRepository();
  if (installs === null) return [];
  return installs
    .list()
    .filter((install) => install.status === 'active')
    .flatMap((install) => {
      const next = buildManifestFor(install);
      return next === null
        ? []
        : [
            {
              installId: install.installId,
              pluginId: install.pluginId,
              displayName: next.manifest.display_name,
              fromVersion: install.currentVersion,
              toVersion: next.manifest.version,
            },
          ];
    });
}

/** Review the build's manifest as this install's update; `confirmUpdate` applies it. */
export function prepareFirstPartyUpdate(args: {
  installId: string;
  nowMs: number;
}): PrepareUpdateResult {
  const install = getPluginInstallRepository()?.getById(args.installId) ?? null;
  if (install === null) {
    return { ok: false, code: 'install_unknown', message: 'no such install', transient: false };
  }
  const next = buildManifestFor(install);
  if (next === null) {
    return {
      ok: false,
      code: 'cid_unchanged',
      message: 'this build ships no newer manifest for this install',
      transient: false,
    };
  }
  return prepareUpdateFromTrustedManifest({
    installId: args.installId,
    manifest: next.manifest,
    cid: next.cid,
    nowMs: args.nowMs,
  });
}

export type FirstPartyConfirmResult = ConfirmUpdateResult & { listing?: SupplierListingOutcome };

/**
 * Apply the reviewed update. The coordinator keeps the install and moves the
 * listing's existing lanes to the new manifest; a lane the new version adds
 * (1.1.0's counter lane) is bound here by the same binder an install's
 * consent uses.
 */
export async function confirmFirstPartyUpdate(args: {
  installId: string;
  toCid: string;
  acceptedWidening?: readonly WideningFinding[];
  acceptedBehaviorHash?: string;
  nowMs: number;
}): Promise<FirstPartyConfirmResult> {
  const result = confirmUpdate({
    installId: args.installId,
    toCid: args.toCid,
    ...(args.acceptedWidening === undefined ? {} : { acceptedWidening: args.acceptedWidening }),
    ...(args.acceptedBehaviorHash === undefined
      ? {}
      : { acceptedBehaviorHash: args.acceptedBehaviorHash }),
    nowMs: args.nowMs,
  });
  if (!result.ok || !result.outcome.ok) return result;
  const install = getPluginInstallRepository()?.getById(args.installId) ?? null;
  if (install === null || install.pluginId !== SUPPLIER_REFERENCE_MANIFEST.plugin_id) return result;
  const listing = await bindSupplierListing({ installId: args.installId, name: listingName() });
  return { ...result, listing };
}

function listingName(): string {
  const business = getCommerceRuntime()?.settings.readBusiness();
  return supplierListingNameFor(
    business !== undefined && business.ok ? business.settings.legalName : undefined,
  );
}
