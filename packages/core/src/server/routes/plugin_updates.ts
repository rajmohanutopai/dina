/**
 * The owner's plugin-update surface (§9.13, §16.5 — WS-3.7).
 *
 *   POST /v1/plugins/update/prepare  → fetch, verify and REVIEW a release
 *   POST /v1/plugins/update/confirm  → apply the one that was reviewed
 *
 * TWO CALLS, because looking at an update must not apply it. §16.5's "an update
 * cannot silently widen" is a statement about consent, and consent needs a
 * moment between being shown something and agreeing to it.
 *
 * OWNER-ONLY, and the reason is stronger here than on a read surface: this
 * changes which code runs under an install's existing grants. A plugin able to
 * update itself would be a plugin able to grant itself anything, one version at
 * a time.
 */

import {
  confirmUpdate,
  prepareUpdate,
  type ConfirmUpdateResult,
  type PrepareUpdateResult,
} from '../../plugins/update_service';

import { makeOwnerGuard } from './owner_guard';

import type { WideningFinding } from '../../plugins/update_widening';
import type { CoreResponse, CoreRouter } from '../router';
import type { PluginTrustAnchor } from '@dina/protocol';

export function registerPluginUpdateRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may update an installed plugin',
  );

  router.post('/v1/plugins/update/prepare', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as { install_id?: unknown; rkey?: unknown };
    const installId = typeof body.install_id === 'string' ? body.install_id : '';
    const rkey = typeof body.rkey === 'string' ? body.rkey : '';
    if (installId === '' || rkey === '') {
      return { status: 400, body: { error: 'install_id and rkey are required' } };
    }

    // The anchor is NOT taken from the request. P0 supports exactly one
    // authenticity path, and letting a caller name the anchor would let them
    // label a repo-proof result as some other authority.
    const trustAnchor: PluginTrustAnchor = { kind: 'repo_proof' };
    const result = await prepareUpdate({ installId, rkey, trustAnchor, nowMs: Date.now() });
    return { status: statusForPrepare(result), body: result };
  });

  router.post('/v1/plugins/update/confirm', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as {
      install_id?: unknown;
      to_cid?: unknown;
      accepted_widening?: unknown;
      accepted_behavior_hash?: unknown;
    };
    const installId = typeof body.install_id === 'string' ? body.install_id : '';
    const toCid = typeof body.to_cid === 'string' ? body.to_cid : '';
    if (installId === '' || toCid === '') {
      return { status: 400, body: { error: 'install_id and to_cid are required' } };
    }

    // Echoed back from the review, and read structurally rather than trusted:
    // it crosses the wire as plain data. The coordinator compares it against
    // what it detects itself, so a malformed or partial echo simply fails to
    // match and the update is refused — which is the same answer as no consent.
    const accepted = readWidening(body.accepted_widening);

    // §20.12 — the behaviour hash the owner was SHOWN, echoed back. Read the
    // same way and for the same reason as the widening above: the coordinator
    // re-derives the candidate's hash and compares, so a wrong or stale echo
    // refuses rather than applies.
    //
    // Without this field the route could not satisfy `confirmUpdate`'s
    // behaviour gate at all, so every update whose behaviour hash had moved
    // was refused for ever and the gate's satisfying branch was reachable
    // only from unit tests.
    const acceptedBehaviorHash =
      typeof body.accepted_behavior_hash === 'string' && body.accepted_behavior_hash !== ''
        ? body.accepted_behavior_hash
        : null;

    const result = confirmUpdate({
      installId,
      toCid,
      ...(accepted === null ? {} : { acceptedWidening: accepted }),
      ...(acceptedBehaviorHash === null ? {} : { acceptedBehaviorHash }),
      nowMs: Date.now(),
    });
    return { status: statusForConfirm(result), body: result };
  });
}

/**
 * A TRANSIENT failure is 503 and a permanent one is 409, because the two ask
 * the caller for different things: try again, versus do something else. A
 * missing install is 404 — the request named something that is not here.
 */
function statusForPrepare(result: PrepareUpdateResult): number {
  if (result.ok) return 200;
  if (result.code === 'install_unknown') return 404;
  return result.transient ? 503 : 409;
}

function statusForConfirm(result: ConfirmUpdateResult): number {
  if (!result.ok) return result.code === 'install_unknown' ? 404 : 409;
  // A COORDINATOR REFUSAL IS NOT A 200. `requires_reconsent` in particular is
  // the owner being asked again, and a client reading only the HTTP status must
  // not render it as "updated".
  return result.outcome.ok ? 200 : 409;
}

/** Read the echoed findings without trusting their shape. */
function readWidening(value: unknown): WideningFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: WideningFinding[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const f = entry as { kind?: unknown; capabilityId?: unknown; from?: unknown; to?: unknown };
    if (typeof f.kind !== 'string' || typeof f.capabilityId !== 'string') return null;
    if (typeof f.to !== 'string') return null;
    if (f.from !== undefined && typeof f.from !== 'string') return null;
    findings.push({
      kind: f.kind as WideningFinding['kind'],
      capabilityId: f.capabilityId,
      ...(f.from === undefined ? {} : { from: f.from }),
      to: f.to,
    });
  }
  return findings;
}
