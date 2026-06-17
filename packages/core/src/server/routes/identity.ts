/**
 * Node identity route — read-only HTTP surface that publishes this node's
 * public identity (DID + handle) so a thin web client (and any UI) can
 * discover + adopt the node's identity without re-onboarding.
 *
 *   GET /v1/identity — returns `{ did, handle }`.
 *     - `did`    : the node's did:plc (or did:key), set at startup.
 *     - `handle` : the PDS handle, or null for a local did:key node.
 *
 * Auth: `public`. The DID is in the PLC directory and the handle is the
 * public ATProto handle — neither is a secret. The PDS password / email /
 * seed in `pds_identity.json` are NEVER exposed here. (Web thin-client
 * design §4.2: the core-server is the source of truth for identity; the
 * brain-server proxies this at `/api/v1/identity`.)
 */
import type { CoreResponse, CoreRouter } from '../router';
import { getNodeIdentity, type NodeIdentity } from '../../pairing/ceremony';

export const IDENTITY_PATH = '/v1/identity';

export function registerIdentityRoutes(router: CoreRouter): void {
  router.get(
    IDENTITY_PATH,
    async (): Promise<CoreResponse> => ({
      status: 200,
      body: getNodeIdentity() satisfies NodeIdentity,
    }),
    { auth: 'public' },
  );
}
