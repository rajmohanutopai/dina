/**
 * DID document `assertionMethod` resolver (TN-AUTH-001).
 *
 * Pins the rules AppView's signature gate (TN-AUTH-002) and the
 * mobile namespace verifier rely on:
 *
 *   - Missing / empty `assertionMethod` → `[]`.
 *   - String references resolve via case-sensitive id match against
 *     `verificationMethod[i].id`.
 *   - Fragment-only refs (`#namespace_0`) expand against `doc.id`.
 *   - Fully-qualified refs (`did:plc:xxxx#namespace_0`) match exact.
 *   - Dangling references silently skip — never blind the caller to
 *     the rest of the assertion-method set.
 *   - Inline VerificationMethod objects pass through (identity
 *     preserved).
 *   - Duplicate entries are NOT silently de-duplicated — the spec
 *     allows duplicates and dedupe is the caller's concern.
 *   - Order matches the input `assertionMethod` order.
 *   - Malformed entries (number, null, unstructured object) are
 *     skipped without throwing.
 *
 * Also covers the convenience wrapper `resolveAssertionMethod`
 * which accepts bare fragments, fragment-with-hash, or fully-
 * qualified refs.
 *
 * Pure function — runs under plain Jest, no runtime deps.
 */

import {
  resolveAssertionMethod,
  resolveAssertionMethods,
} from '../src/identity/did_resolver';

import type { DIDDocument, VerificationMethod } from '../src/types/plc_document';

const DID = 'did:plc:abc123';

function vm(fragment: string, multibase = 'z6MkExample'): VerificationMethod {
  return {
    id: `${DID}#${fragment}`,
    type: 'Multikey',
    controller: DID,
    publicKeyMultibase: multibase,
  };
}

function doc(overrides: Partial<DIDDocument> = {}): DIDDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: DID,
    verificationMethod: [vm('key-1')],
    authentication: [`${DID}#key-1`],
    service: [],
    ...overrides,
  };
}

// ─── resolveAssertionMethods — empty paths ────────────────────────────────

describe('resolveAssertionMethods — empty paths', () => {
  it('returns [] when assertionMethod is absent', () => {
    expect(resolveAssertionMethods(doc())).toEqual([]);
  });

  it('returns [] when assertionMethod is an empty array', () => {
    expect(resolveAssertionMethods(doc({ assertionMethod: [] }))).toEqual([]);
  });

  it('returns [] when assertionMethod is non-array (defensive)', () => {
    // @ts-expect-error — runtime guard for callers ignoring TS
    expect(resolveAssertionMethods(doc({ assertionMethod: 'not-an-array' }))).toEqual([]);
  });
});

// ─── resolveAssertionMethods — string refs ────────────────────────────────

describe('resolveAssertionMethods — string references', () => {
  it('resolves fully-qualified refs to the matching VM', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const ns1 = vm('namespace_1', 'z6MkNs1');
    const d = doc({
      verificationMethod: [vm('key-1'), ns0, ns1],
      assertionMethod: [`${DID}#namespace_0`, `${DID}#namespace_1`],
    });
    const out = resolveAssertionMethods(d);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ns0); // identity preserved
    expect(out[1]).toBe(ns1);
  });

  it('resolves fragment-only refs by expanding against doc.id', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      verificationMethod: [vm('key-1'), ns0],
      assertionMethod: ['#namespace_0'],
    });
    const out = resolveAssertionMethods(d);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ns0);
  });

  it('preserves order from the input assertionMethod array', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const ns1 = vm('namespace_1', 'z6MkNs1');
    const d = doc({
      verificationMethod: [ns0, ns1, vm('key-1')],
      assertionMethod: [`${DID}#namespace_1`, `${DID}#namespace_0`],
    });
    const out = resolveAssertionMethods(d);
    expect(out.map((v) => v.publicKeyMultibase)).toEqual(['z6MkNs1', 'z6MkNs0']);
  });

  it('skips dangling references without losing the rest', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      verificationMethod: [vm('key-1'), ns0],
      assertionMethod: [
        `${DID}#namespace_0`,
        `${DID}#namespace_99`, // dangling
        `${DID}#namespace_404`, // also dangling
      ],
    });
    const out = resolveAssertionMethods(d);
    expect(out).toEqual([ns0]);
  });

  it('preserves duplicate references — caller decides whether to dedupe', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      verificationMethod: [vm('key-1'), ns0],
      assertionMethod: [`${DID}#namespace_0`, `${DID}#namespace_0`],
    });
    const out = resolveAssertionMethods(d);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(out[1]);
    expect(out[0]).toBe(ns0);
  });

  it('id match is case-sensitive (W3C URI matching is byte-exact)', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      verificationMethod: [ns0],
      // Wrong case in the fragment portion.
      assertionMethod: [`${DID}#NAMESPACE_0`],
    });
    expect(resolveAssertionMethods(d)).toEqual([]);
  });

  it('returns [] when doc.id is empty and ref is fragment-only (no expansion target)', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      id: '',
      verificationMethod: [{ ...ns0, id: '#namespace_0', controller: '' }],
      assertionMethod: ['#namespace_0'],
    });
    const out = resolveAssertionMethods(d);
    // Exact match against the VM whose id IS literally `#namespace_0`
    // still works — only the doc.id-based expansion is short-circuited.
    expect(out).toHaveLength(1);
    const first = out[0];
    if (first === undefined) throw new Error('expected one resolved VM');
    expect(first.id).toBe('#namespace_0');
  });
});

// ─── resolveAssertionMethods — inline VMs ─────────────────────────────────

describe('resolveAssertionMethods — inline VerificationMethod objects', () => {
  it('returns inline VMs as-is (identity preserved)', () => {
    const inlineVM = vm('inline_key', 'z6MkInline');
    const d = doc({
      verificationMethod: [vm('key-1')],
      assertionMethod: [inlineVM],
    });
    const out = resolveAssertionMethods(d);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(inlineVM);
  });

  it('mixes inline and string entries in a single call', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const inlineVM = vm('inline_key', 'z6MkInline');
    const d = doc({
      verificationMethod: [ns0],
      assertionMethod: [`${DID}#namespace_0`, inlineVM],
    });
    const out = resolveAssertionMethods(d);
    expect(out).toEqual([ns0, inlineVM]);
  });
});

// ─── resolveAssertionMethods — malformed input ────────────────────────────

describe('resolveAssertionMethods — malformed entries', () => {
  it('skips numbers, nulls, and arrays without throwing', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      verificationMethod: [ns0],
      // @ts-expect-error — defensive runtime guard
      assertionMethod: [42, null, ['nested'], `${DID}#namespace_0`, undefined],
    });
    expect(resolveAssertionMethods(d)).toEqual([ns0]);
  });

  it('skips inline objects missing required VM fields', () => {
    const valid = vm('namespace_0');
    const d = doc({
      verificationMethod: [valid],
      assertionMethod: [
        // missing publicKeyMultibase
        { id: `${DID}#bad_inline`, type: 'Multikey', controller: DID } as VerificationMethod,
        // wrong type (non-Multikey is not in our domain)
        {
          id: `${DID}#bad_type`,
          type: 'Ed25519VerificationKey2020',
          controller: DID,
          publicKeyMultibase: 'z',
        } as unknown as VerificationMethod,
        valid,
      ],
    });
    expect(resolveAssertionMethods(d)).toEqual([valid]);
  });

  it('handles a verificationMethod array with malformed entries (defensive)', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      // @ts-expect-error — defensive runtime guard
      verificationMethod: [null, 'string', { id: 'incomplete' }, ns0],
      assertionMethod: [`${DID}#namespace_0`],
    });
    expect(resolveAssertionMethods(d)).toEqual([ns0]);
  });
});

// ─── resolveAssertionMethods — purity ─────────────────────────────────────

describe('resolveAssertionMethods — purity', () => {
  it('does not mutate the input document or its arrays', () => {
    const ns0 = vm('namespace_0', 'z6MkNs0');
    const d = doc({
      verificationMethod: [ns0],
      assertionMethod: [`${DID}#namespace_0`],
    });
    const beforeAssertion = JSON.stringify(d.assertionMethod);
    const beforeVMs = JSON.stringify(d.verificationMethod);
    resolveAssertionMethods(d);
    expect(JSON.stringify(d.assertionMethod)).toBe(beforeAssertion);
    expect(JSON.stringify(d.verificationMethod)).toBe(beforeVMs);
  });

  it('returns a fresh array each call (caller can mutate without poisoning)', () => {
    const d = doc({
      verificationMethod: [vm('namespace_0')],
      assertionMethod: [`${DID}#namespace_0`],
    });
    const a = resolveAssertionMethods(d);
    const b = resolveAssertionMethods(d);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ─── resolveAssertionMethod — single lookup ───────────────────────────────

describe('resolveAssertionMethod — single lookup', () => {
  const ns0 = vm('namespace_0', 'z6MkNs0');
  const ns1 = vm('namespace_1', 'z6MkNs1');
  const d = doc({
    verificationMethod: [vm('key-1'), ns0, ns1],
    assertionMethod: [`${DID}#namespace_0`, `${DID}#namespace_1`],
  });

  it('matches a fully-qualified id', () => {
    expect(resolveAssertionMethod(d, `${DID}#namespace_0`)).toBe(ns0);
  });

  it('matches a fragment-with-hash ref', () => {
    expect(resolveAssertionMethod(d, '#namespace_1')).toBe(ns1);
  });

  it('matches a bare fragment (no leading #)', () => {
    expect(resolveAssertionMethod(d, 'namespace_0')).toBe(ns0);
  });

  it('returns null for a fragment NOT in assertionMethod, even if listed in verificationMethod', () => {
    // `key-1` is in verificationMethod[] but NOT in assertionMethod[],
    // so the assertion-resolver must reject it.
    expect(resolveAssertionMethod(d, 'key-1')).toBeNull();
  });

  it('returns null for an unknown fragment', () => {
    expect(resolveAssertionMethod(d, 'namespace_404')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(resolveAssertionMethod(d, '')).toBeNull();
    // @ts-expect-error — runtime guard
    expect(resolveAssertionMethod(d, undefined)).toBeNull();
    // @ts-expect-error — runtime guard
    expect(resolveAssertionMethod(d, null)).toBeNull();
  });

  it('returns null when the doc has no assertionMethod field', () => {
    const bareDoc = doc({ verificationMethod: [ns0] });
    expect(resolveAssertionMethod(bareDoc, 'namespace_0')).toBeNull();
  });
});
