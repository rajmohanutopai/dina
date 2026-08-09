import { getNodeDID } from '../../pairing/ceremony';

import type { CoreRequest, CoreResponse } from '../router';

export function ownerDidForRequest(
  req: CoreRequest,
  expectedCapability: string | undefined,
): string | CoreResponse {
  const ownerDid = getNodeDID();
  if (ownerDid === null) {
    return { status: 503, body: { error: 'owner_identity_unavailable' } };
  }
  if (
    req.callerType === 'owner' &&
    expectedCapability !== undefined &&
    expectedCapability !== '' &&
    req.ownerCapability === expectedCapability
  ) {
    return ownerDid;
  }
  if ((req.callerType === 'admin' || req.callerType === 'device') && req.callerDID === ownerDid) {
    return ownerDid;
  }
  return {
    status: 403,
    body: { error: 'access_denied', reason: 'owner authorization required' },
  };
}

/** Returns a refusal, or null when the caller is the owner. */
export type OwnerGuard = (req: CoreRequest) => CoreResponse | null;

/**
 * Owner guard bound to the boot-minted capability (§12.5, F15) — closure-held,
 * fail-closed when unconfigured.
 *
 * DEFENCE IN DEPTH, not a hard boundary: a Brain executing arbitrary hostile JS
 * in the shared mobile VM can still skim the secret off a live owner request
 * (patch `CoreRouter.prototype.handle`). That is out of scope for any in-VM
 * mechanism; the server split is the strong boundary (see router.ts
 * `CoreRequest.ownerCapability` + SECURITY.md).
 *
 * FAIL CLOSED: a router registered without a capability — Brain's own router,
 * or a server split with no in-process owner surface — rejects every owner
 * call. A caller must BOTH be owner-marked AND present the exact capability.
 *
 * ONE copy. `run.ts` and `watch.ts` each carried their own identical version,
 * differing only in the refusal wording, and a third was about to be written
 * for commerce. Three copies of an authorization check is three places for a
 * fix to be applied twice — so `reason` is the only parameter, and the check
 * itself lives here.
 */
export function makeOwnerGuard(
  expectedCapability: string | undefined,
  reason: string,
): OwnerGuard {
  return (req) => {
    if (expectedCapability === undefined || expectedCapability === '') {
      return {
        status: 403,
        body: { error: 'access_denied', reason: 'owner control plane not configured' },
      };
    }
    if (req.callerType !== 'owner' || req.ownerCapability !== expectedCapability) {
      return { status: 403, body: { error: 'access_denied', reason } };
    }
    return null;
  };
}
