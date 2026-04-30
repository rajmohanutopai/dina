/**
 * Tests for `src/trust/namespace_screen_data.ts` (TN-MOB-014).
 *
 * Pure data-layer derivation: PLC operation → display-ready rows. The
 * screen layer (`app/trust/namespace.tsx`) renders these directly;
 * the heavier component-render tests live in `namespace.render.test.tsx`.
 *
 * Coverage:
 *   - Empty / null / malformed PLC ops → `[]` (the screen renders the
 *     loading or empty state respectively).
 *   - Filters non-`namespace_<N>` keys (root signing keys, capability
 *     keys, malformed names).
 *   - Returns rows in numeric-index ascending order regardless of
 *     source key order (deterministic UI).
 *   - Constructs the canonical verificationMethodId.
 *   - `canAddNamespace` + `nextNamespaceIndexFor` match the prior-op
 *     null/non-null discipline.
 */

import {
  deriveNamespaceRows,
  canAddNamespace,
  nextNamespaceIndexFor,
} from '../../src/trust/namespace_screen_data';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

describe('deriveNamespaceRows', () => {
  it('returns [] when prior is null', () => {
    expect(deriveNamespaceRows(DID, null)).toEqual([]);
  });

  it('returns [] when prior is undefined', () => {
    expect(deriveNamespaceRows(DID, undefined)).toEqual([]);
  });

  it('returns [] when verificationMethods is missing', () => {
    expect(deriveNamespaceRows(DID, {})).toEqual([]);
  });

  it('returns [] when verificationMethods is malformed (not an object)', () => {
    expect(deriveNamespaceRows(DID, { verificationMethods: 'not-an-object' })).toEqual([]);
    expect(deriveNamespaceRows(DID, { verificationMethods: null })).toEqual([]);
    expect(deriveNamespaceRows(DID, { verificationMethods: [] })).toEqual([]);
  });

  it('returns one row per namespace_<N> key, sorted ascending by index', () => {
    // Source order is intentionally jumbled to verify deterministic sort.
    const prior = {
      verificationMethods: {
        namespace_2: 'multikey-2',
        namespace_0: 'multikey-0',
        namespace_5: 'multikey-5',
        namespace_1: 'multikey-1',
      },
    };
    const rows = deriveNamespaceRows(DID, prior);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 5]);
    expect(rows.map((r) => r.fragment)).toEqual([
      'namespace_0',
      'namespace_1',
      'namespace_2',
      'namespace_5',
    ]);
  });

  it('constructs the verificationMethodId as did#fragment', () => {
    const prior = { verificationMethods: { namespace_3: 'multikey' } };
    const rows = deriveNamespaceRows(DID, prior);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verificationMethodId).toBe(`${DID}#namespace_3`);
  });

  it('filters out non-namespace keys (root signing, capability)', () => {
    // The PLC op also lists the user's atproto-signing key + recovery
    // keys etc. Those don't belong on the namespace screen.
    const prior = {
      verificationMethods: {
        atproto: 'multikey-root',
        capability_invocation: 'multikey-cap',
        namespace_0: 'multikey-0',
      },
    };
    const rows = deriveNamespaceRows(DID, prior);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fragment).toBe('namespace_0');
  });

  it('filters out malformed namespace keys (namespace_abc, namespace_-1)', () => {
    const prior = {
      verificationMethods: {
        namespace_abc: 'multikey-bad',
        'namespace_-1': 'multikey-neg',
        namespace_0: 'multikey-0',
        namespace_2: 'multikey-2',
      },
    };
    const rows = deriveNamespaceRows(DID, prior);
    expect(rows.map((r) => r.index)).toEqual([0, 2]);
  });

  it('preserves leading-zero indexes per the regex (\\d+)', () => {
    // `namespace_007` parses as index 7. Whether the PLC layer ever
    // emits this is the composer's concern; the screen tolerates it.
    const prior = { verificationMethods: { namespace_007: 'multikey' } };
    const rows = deriveNamespaceRows(DID, prior);
    expect(rows[0]?.index).toBe(7);
    // Fragment retains the source-key form so the screen displays it
    // exactly as the user's DID document does.
    expect(rows[0]?.fragment).toBe('namespace_007');
  });
});

describe('canAddNamespace', () => {
  it('returns false when prior is null', () => {
    expect(canAddNamespace(null)).toBe(false);
  });

  it('returns false when prior is undefined', () => {
    expect(canAddNamespace(undefined)).toBe(false);
  });

  it('returns true when prior is an object (even empty)', () => {
    // Even an op with no namespaces yet — the user can add the first one.
    expect(canAddNamespace({})).toBe(true);
    expect(canAddNamespace({ verificationMethods: {} })).toBe(true);
  });
});

describe('nextNamespaceIndexFor', () => {
  it('returns null when prior is null', () => {
    expect(nextNamespaceIndexFor(null)).toBeNull();
  });

  it('returns null when prior is undefined', () => {
    expect(nextNamespaceIndexFor(undefined)).toBeNull();
  });

  it('returns 0 for an op with no namespaces', () => {
    expect(nextNamespaceIndexFor({ verificationMethods: {} })).toBe(0);
  });

  it('returns the lowest unused index', () => {
    const prior = {
      verificationMethods: {
        namespace_0: 'a',
        namespace_1: 'b',
        namespace_3: 'c', // gap at 2
      },
    };
    expect(nextNamespaceIndexFor(prior)).toBe(2);
  });

  it('returns N+1 for a contiguous N-namespace op', () => {
    const prior = {
      verificationMethods: { namespace_0: 'a', namespace_1: 'b', namespace_2: 'c' },
    };
    expect(nextNamespaceIndexFor(prior)).toBe(3);
  });
});
