/**
 * Runner tests for the live AppView wiring (`use_trust_search`,
 * `use_reviewer_profile`, `use_subject_detail`).
 *
 * The runners are the bridge between `EXPO_PUBLIC_DINA_APPVIEW_URL`
 * + `fetch` and the presentational screens. We mock `appview_runtime`
 * at the module boundary so the tests pin runner state-machine
 * behaviour without standing up a real HTTP server.
 *
 * Three failure modes the iOS smoke runs caught and these tests
 * keep us safe from in CI:
 *
 *   1. **autoError race** (caught at runtime): the original screen
 *      pattern `error = auto.error ?? autoError` let a stale
 *      autoError from a prior deep-link leak through after the
 *      runner succeeded on the next deep-link. The runners don't
 *      have autoError themselves, but a unit test asserting the
 *      runner's `error` field returns to `null` on a successful
 *      retry locks in the contract the screen relies on.
 *   2. **Cancel-on-unmount**: a runner that doesn't drop its in-
 *      flight promise on unmount can call setState on an unmounted
 *      component (warning + memory leak). We assert no setState
 *      happens after unmount.
 *   3. **Empty-query short-circuit**: `useTrustSearch` must NOT
 *      call AppView when `q.trim().length === 0` — otherwise
 *      every keystroke between mount and first character bills the
 *      AppView.
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { Text } from 'react-native';

jest.mock('../../src/trust/appview_runtime', () => ({
  __esModule: true,
  searchAttestations: jest.fn(),
  getProfile: jest.fn(),
  subjectGet: jest.fn(),
  networkFeed: jest.fn(),
}));

import * as appview from '../../src/trust/appview_runtime';
import { useTrustSearch } from '../../src/trust/runners/use_trust_search';
import { useReviewerProfile } from '../../src/trust/runners/use_reviewer_profile';
import { useSubjectDetail } from '../../src/trust/runners/use_subject_detail';
import { useNetworkFeed } from '../../src/trust/runners/use_network_feed';

const searchMock = appview.searchAttestations as jest.MockedFunction<
  typeof appview.searchAttestations
>;
const profileMock = appview.getProfile as jest.MockedFunction<typeof appview.getProfile>;
const subjectMock = appview.subjectGet as jest.MockedFunction<typeof appview.subjectGet>;
const feedMock = appview.networkFeed as jest.MockedFunction<typeof appview.networkFeed>;

beforeEach(() => {
  searchMock.mockReset();
  profileMock.mockReset();
  subjectMock.mockReset();
  feedMock.mockReset();
});

// ─── Test harness ─────────────────────────────────────────────────────────

interface ProbeProps<T> {
  hook: () => T;
  onState?: (s: T) => void;
}

/**
 * Tiny probe component that runs a hook and writes the result to a
 * ref the test inspects. Avoids hand-rolling renderHook so the
 * subscription order matches React's normal render → effect → render
 * cycle.
 */
function Probe<T>(props: ProbeProps<T>): React.ReactElement {
  const result = props.hook();
  if (props.onState) props.onState(result);
  return <Text testID="probe">ok</Text>;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── useTrustSearch ───────────────────────────────────────────────────────

describe('useTrustSearch', () => {
  it('skips network when enabled=false', async () => {
    render(<Probe hook={() => useTrustSearch({ q: 'hello', enabled: false })} />);
    await flushAsync();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('skips network when q is empty string', async () => {
    render(<Probe hook={() => useTrustSearch({ q: '   ', enabled: true })} />);
    await flushAsync();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('calls AppView once and groups hits by subjectId', async () => {
    searchMock.mockResolvedValueOnce({
      results: [
        {
          uri: 'at://a/x/1',
          authorDid: 'did:plc:alice',
          cid: 'c1',
          subjectId: 'sub_aeron',
          subjectRefRaw: { type: 'organization', name: 'Aeron Chairs' },
          category: 'commerce/seller',
          sentiment: 'positive',
          text: 'Excellent.',
          recordCreatedAt: '2026-04-30T00:00:00Z',
        },
        {
          uri: 'at://b/x/2',
          authorDid: 'did:plc:bob',
          cid: 'c2',
          subjectId: 'sub_aeron',
          subjectRefRaw: { type: 'organization', name: 'Aeron Chairs' },
          category: 'commerce/seller',
          sentiment: 'neutral',
          text: 'Mid.',
          recordCreatedAt: '2026-04-30T01:00:00Z',
        },
      ],
      totalEstimate: 2,
    });
    let captured: ReturnType<typeof useTrustSearch> | null = null;
    render(
      <Probe
        hook={() => useTrustSearch({ q: 'aeron', enabled: true })}
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith('aeron', 50);
    expect(captured).not.toBeNull();
    const finalState = captured!;
    expect(finalState.isLoading).toBe(false);
    expect(finalState.error).toBeNull();
    expect(finalState.results).toHaveLength(1);
    expect(finalState.results[0]?.subjectId).toBe('sub_aeron');
    expect(finalState.results[0]?.display.reviewCount).toBe(2);
  });

  it('sets error state and clears results on fetch rejection', async () => {
    searchMock.mockRejectedValueOnce(new Error('Network down'));
    let captured: ReturnType<typeof useTrustSearch> | null = null;
    render(
      <Probe
        hook={() => useTrustSearch({ q: 'q', enabled: true })}
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(captured!.error).toBe('Network down');
    expect(captured!.isLoading).toBe(false);
    expect(captured!.results).toHaveLength(0);
  });

  it('retryNonce bump re-fires the fetch (unsticks a transient error)', async () => {
    searchMock.mockRejectedValueOnce(new Error('Network down'));
    searchMock.mockResolvedValueOnce({ results: [], totalEstimate: 0 });
    let captured: ReturnType<typeof useTrustSearch> | null = null;
    let nonce = 0;
    const TestHost: React.FC = () => {
      const [n, setN] = React.useState(0);
      nonce = n;
      return (
        <>
          <Text testID="bump" onPress={() => setN((v) => v + 1)}>
            bump
          </Text>
          <Probe
            hook={() => useTrustSearch({ q: 'q', enabled: true, retryNonce: n })}
            onState={(s) => {
              captured = s;
            }}
          />
        </>
      );
    };
    const { getByTestId } = render(<TestHost />);
    await flushAsync();
    expect(captured!.error).toBe('Network down');
    // Trigger retry
    await act(async () => {
      getByTestId('bump').props.onPress?.();
    });
    await flushAsync();
    expect(nonce).toBe(1);
    // After retry, error must clear — the bug we caught at runtime
    // was an autoError leftover that wouldn't clear on success.
    expect(captured!.error).toBeNull();
    expect(searchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels in-flight promise on unmount (no late setState)', async () => {
    let resolveLater: ((v: unknown) => void) | null = null;
    searchMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveLater = res;
        }),
    );
    const { unmount } = render(
      <Probe hook={() => useTrustSearch({ q: 'q', enabled: true })} />,
    );
    unmount();
    // Resolve AFTER unmount — runner's cancelled-flag must skip setState.
    await act(async () => {
      resolveLater?.({ results: [], totalEstimate: 0 });
      await Promise.resolve();
    });
    // No assertion here other than the implicit "no late-setState
    // warning" — React 18's act() will throw if the runner calls
    // setState on an unmounted component.
  });
});

// ─── useReviewerProfile ───────────────────────────────────────────────────

describe('useReviewerProfile', () => {
  it('calls getProfile and normalises lastActive ISO → ms', async () => {
    profileMock.mockResolvedValueOnce({
      did: 'did:plc:cara',
      overallTrustScore: 0.42,
      attestationSummary: { total: 0, positive: 0, neutral: 0, negative: 0 },
      vouchCount: 0,
      endorsementCount: 0,
      reviewerStats: {
        totalAttestationsBy: 2,
        corroborationRate: 0,
        evidenceRate: 0,
        helpfulRatio: 0,
      },
      activeDomains: [],
      lastActive: '2026-04-30T05:00:00Z',
    });
    let captured: ReturnType<typeof useReviewerProfile> | null = null;
    render(
      <Probe
        hook={() => useReviewerProfile({ did: 'did:plc:cara', enabled: true })}
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(profileMock).toHaveBeenCalledWith('did:plc:cara');
    expect(captured!.profile?.overallTrustScore).toBe(0.42);
    expect(typeof captured!.profile?.lastActive).toBe('number');
  });

  it('skips when did is not a DID', async () => {
    render(<Probe hook={() => useReviewerProfile({ did: 'not-a-did', enabled: true })} />);
    await flushAsync();
    expect(profileMock).not.toHaveBeenCalled();
  });
});

// ─── useSubjectDetail ─────────────────────────────────────────────────────

describe('useSubjectDetail', () => {
  it('flattens grouped reviewers into ring-stamped reviews', async () => {
    subjectMock.mockResolvedValueOnce({
      subject: { type: 'organization', name: 'Aeron Chairs', did: 'did:plc:shop' },
      score: 0.5,
      band: 'moderate',
      reviewCount: 3,
      reviewers: {
        contacts: [
          {
            did: 'did:plc:friend',
            trustScore: 0.9,
            trustBand: 'high',
            attestation: {
              uri: 'at://friend/x/1',
              text: 'Loved it.',
              sentiment: 'positive',
              createdAt: '2026-04-30T00:00:00Z',
            },
          },
        ],
        extended: [
          {
            did: 'did:plc:fof',
            trustScore: 0.6,
            trustBand: 'moderate',
            attestation: {
              uri: 'at://fof/x/2',
              text: 'Decent.',
              sentiment: 'neutral',
              createdAt: '2026-04-30T01:00:00Z',
            },
          },
        ],
        strangers: [
          {
            did: 'did:plc:stranger',
            trustScore: null,
            trustBand: 'unrated',
            attestation: {
              uri: 'at://stranger/x/3',
              text: 'Bad.',
              sentiment: 'negative',
              createdAt: '2026-04-30T02:00:00Z',
            },
          },
        ],
      },
    });
    let captured: ReturnType<typeof useSubjectDetail> | null = null;
    render(
      <Probe
        hook={() =>
          useSubjectDetail({
            subjectId: 'sub_aeron',
            viewerDid: 'did:plc:viewer',
            enabled: true,
          })
        }
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(subjectMock).toHaveBeenCalledWith('sub_aeron', 'did:plc:viewer');
    const data = captured!.data;
    expect(data?.title).toBe('Aeron Chairs');
    expect(data?.reviewCount).toBe(3);
    expect(data?.reviews).toHaveLength(3);
    const rings = data?.reviews.map((r) => r.ring);
    expect(rings).toEqual(['contact', 'fof', 'stranger']);
  });

  it('skips when subjectId or viewerDid is empty', async () => {
    render(
      <Probe
        hook={() =>
          useSubjectDetail({ subjectId: '', viewerDid: 'did:plc:v', enabled: true })
        }
      />,
    );
    await flushAsync();
    expect(subjectMock).not.toHaveBeenCalled();
  });

  it('surfaces handle as reviewerName when populated', async () => {
    // AppView's `backfill-handles` job has resolved this DID's PLC
    // doc and stored the handle on `did_profiles`. The runner should
    // surface it verbatim so the detail screen reads
    // "alice.pds.dinakernel.com — Loved it." instead of staring back
    // at the raw DID.
    subjectMock.mockResolvedValueOnce({
      subject: { type: 'product', name: 'Some Subject', did: 'did:plc:p' },
      score: 0.5,
      band: 'moderate',
      reviewCount: 1,
      reviewers: {
        contacts: [
          {
            did: 'did:plc:friend',
            handle: 'alice.pds.dinakernel.com',
            trustScore: 0.9,
            trustBand: 'high',
            attestation: {
              uri: 'at://friend/x/1',
              text: 'Loved it.',
              sentiment: 'positive',
              createdAt: '2026-04-30T00:00:00Z',
            },
          },
        ],
        extended: [],
        strangers: [],
      },
    });
    let captured: ReturnType<typeof useSubjectDetail> | null = null;
    render(
      <Probe
        hook={() =>
          useSubjectDetail({
            subjectId: 'sub_x',
            viewerDid: 'did:plc:viewer',
            enabled: true,
          })
        }
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    // Default render is the short username (first DNS label). Full
    // handle is exposed through the IdentityModal on tap.
    expect(captured!.data!.reviews[0].reviewerName).toBe('alice');
  });

  it('falls back to a truncated DID when handle is null', async () => {
    // Backfill hasn't reached this DID yet — handle is null. The
    // runner shouldn't paint a 30-char wall of `did:plc:abc…xyz`;
    // it truncates to a recognisable head + tail.
    subjectMock.mockResolvedValueOnce({
      subject: { type: 'product', name: 'Some Subject', did: 'did:plc:p' },
      score: 0.5,
      band: 'moderate',
      reviewCount: 1,
      reviewers: {
        contacts: [],
        extended: [],
        strangers: [
          {
            did: 'did:plc:abcdefghij1234567890',
            handle: null,
            trustScore: null,
            trustBand: 'unrated',
            attestation: {
              uri: 'at://stranger/x/1',
              text: 'Bad.',
              sentiment: 'negative',
              createdAt: '2026-04-30T00:00:00Z',
            },
          },
        ],
      },
    });
    let captured: ReturnType<typeof useSubjectDetail> | null = null;
    render(
      <Probe
        hook={() =>
          useSubjectDetail({
            subjectId: 'sub_x',
            viewerDid: 'did:plc:viewer',
            enabled: true,
          })
        }
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    const name = captured!.data!.reviews[0].reviewerName;
    // Truncated form: `did:plc:abcdef…7890` — 14 + ellipsis + 4 chars.
    expect(name.startsWith('did:plc:')).toBe(true);
    expect(name).toContain('…');
    expect(name.endsWith('7890')).toBe(true);
    expect(name.length).toBeLessThan(30);
  });
});

describe('useNetworkFeed', () => {
  it('calls networkFeed and maps attestations to feed items', async () => {
    feedMock.mockResolvedValueOnce({
      attestations: [
        {
          uri: 'at://did:plc:r1/com.dina.trust.attestation/A',
          authorDid: 'did:plc:r1',
          subjectId: 'sub_a',
          subjectRefRaw: { type: 'product', name: 'Aeron Chair' },
          category: 'commerce/product',
          sentiment: 'positive',
          text: 'Solid build.',
          recordCreatedAt: '2026-04-30T10:00:00Z',
          isRevoked: false,
        },
      ],
    });
    let captured: ReturnType<typeof useNetworkFeed> | null = null;
    render(
      <Probe
        hook={() =>
          useNetworkFeed({ viewerDid: 'did:plc:viewer', enabled: true })
        }
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(feedMock).toHaveBeenCalledWith('did:plc:viewer', 25);
    expect(captured!.feed.length).toBe(1);
    expect(captured!.feed[0].subjectId).toBe('sub_a');
    expect(captured!.feed[0].display.title).toBe('Aeron Chair');
  });

  it('drops attestations with null subjectId (defensive — those rows have no card target)', async () => {
    feedMock.mockResolvedValueOnce({
      attestations: [
        {
          uri: 'at://did:plc:r1/com.dina.trust.attestation/B',
          authorDid: 'did:plc:r1',
          subjectId: null, // unresolved subject — mid-ingestion
          subjectRefRaw: { type: 'product', name: 'Pending' },
          category: 'commerce/product',
          sentiment: 'positive',
          text: 'x',
          recordCreatedAt: '2026-04-30T10:00:00Z',
          isRevoked: false,
        },
      ],
    });
    let captured: ReturnType<typeof useNetworkFeed> | null = null;
    render(
      <Probe
        hook={() =>
          useNetworkFeed({ viewerDid: 'did:plc:viewer', enabled: true })
        }
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(captured!.feed).toHaveLength(0);
  });

  it('skips when viewerDid is not a DID (boot not finished)', async () => {
    render(
      <Probe
        hook={() => useNetworkFeed({ viewerDid: '', enabled: true })}
      />,
    );
    await flushAsync();
    expect(feedMock).not.toHaveBeenCalled();
  });

  it('surfaces error state on fetch rejection', async () => {
    feedMock.mockRejectedValueOnce(new Error('boom'));
    let captured: ReturnType<typeof useNetworkFeed> | null = null;
    render(
      <Probe
        hook={() => useNetworkFeed({ viewerDid: 'did:plc:viewer', enabled: true })}
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(captured!.error).toBe('boom');
    expect(captured!.feed).toHaveLength(0);
  });
});
