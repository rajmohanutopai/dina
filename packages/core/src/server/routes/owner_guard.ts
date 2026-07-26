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
