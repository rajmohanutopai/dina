/**
 * Contact Services `ask_to_enable` owner actions (P2.3).
 *
 * Pins the two security-load-bearing invariants of the prompt's actions:
 *   - "Allow" → mints the grant via `coreClient.issueServiceOffer({toDID, rkey,
 *     capability})` — the EXISTING provider route (§4 layer-2 reach), bound to
 *     the transport-authed requester + the LOCALLY-resolved rkey (no wire DID).
 *   - "Not now" → makes NO backend call (§2 no-leak). The dismissal is a pure
 *     thread-lifecycle patch (`resolveGrantPrompt`) that never touches the
 *     coreClient — proven here by spying on it.
 *   - `allowGrantRequest` throws when the node isn't booted.
 */

jest.mock('../../src/hooks/useNodeBootstrap', () => ({
  __esModule: true,
  getBootedNode: jest.fn(),
  subscribeBootedNode: jest.fn(() => () => undefined),
}));

import { resetThreads } from '../../../brain/src/chat/thread';
import { getBootedNode } from '../../src/hooks/useNodeBootstrap';
import { postGrantPromptOnce, resolveGrantPrompt } from '../../src/services/grant_prompt';
import { allowGrantRequest } from '../../src/services/grant_request_actions';

const mockGetBootedNode = getBootedNode as jest.MockedFunction<typeof getBootedNode>;

const PEER = 'did:plc:sancho';
const CAP = 'availability_coordination';
const RKEY = 'avail-1';

/** Build a stub booted node whose coreClient records issueServiceOffer calls. */
function stubNode(): {
  node: ReturnType<typeof getBootedNode>;
  offerCalls: { toDID: string; rkey: string; capability: string }[];
} {
  const offerCalls: { toDID: string; rkey: string; capability: string }[] = [];
  const node = {
    coreClient: {
      issueServiceOffer: async (p: { toDID: string; rkey: string; capability: string }) => {
        offerCalls.push(p);
        return { grantId: 'grant-xyz', serviceUri: 'at://x/y/z' };
      },
    },
  } as unknown as ReturnType<typeof getBootedNode>;
  return { node, offerCalls };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetThreads();
});

describe('allowGrantRequest — "Allow" mints the grant via the provider route', () => {
  it('calls coreClient.issueServiceOffer with the requester DID, rkey, and capability', async () => {
    const { node, offerCalls } = stubNode();
    mockGetBootedNode.mockReturnValue(node);

    const res = await allowGrantRequest({ requesterDID: PEER, rkey: RKEY, capability: CAP });

    expect(res).toEqual({ grantId: 'grant-xyz' });
    expect(offerCalls).toHaveLength(1);
    expect(offerCalls[0]).toEqual({ toDID: PEER, rkey: RKEY, capability: CAP });
  });

  it('throws when the node is not booted', async () => {
    mockGetBootedNode.mockReturnValue(null);
    await expect(
      allowGrantRequest({ requesterDID: PEER, rkey: RKEY, capability: CAP }),
    ).rejects.toThrow(/still starting/i);
  });
});

describe('"Not now" dismissal — no backend call (§2 no-leak)', () => {
  it('resolveGrantPrompt(dismissed) patches the card WITHOUT touching the coreClient', async () => {
    const { node, offerCalls } = stubNode();
    mockGetBootedNode.mockReturnValue(node);

    const card = await postGrantPromptOnce(PEER, CAP, RKEY);
    if (card === null) throw new Error('expected a posted card');

    // The dismiss path the card wires to "Not now": a pure lifecycle patch.
    resolveGrantPrompt(PEER, card.id, 'dismissed');

    // The contact must get NO signal — issueServiceOffer was never called.
    expect(offerCalls).toHaveLength(0);
  });
});
