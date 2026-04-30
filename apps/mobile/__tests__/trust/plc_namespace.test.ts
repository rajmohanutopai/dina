/**
 * Mobile facade smoke test for `apps/mobile/src/trust/plc_namespace.ts`
 * (TN-IDENT-005). The composer logic itself is fully tested in
 * `packages/core/__tests__/identity/plc_namespace_update.test.ts`;
 * this file just pins the re-export surface so mobile callers can
 * type-import safely.
 */

import {
  cidForOperation,
  composeAndSignNamespaceDisable,
  composeAndSignNamespaceUpdate,
  composeNamespaceDisable,
  composeNamespaceUpdate,
  computePLCBackoff,
  createNamespace,
  namespaceFragment,
  nextAvailableNamespaceIndex,
  PLC_DEFAULT_BACKOFF_BASE_MS,
  PLC_DEFAULT_MAX_ATTEMPTS,
  PLCSubmitError,
  submitPlcOperation,
} from '../../src/trust/plc_namespace';

describe('apps/mobile/src/trust/plc_namespace re-exports', () => {
  it('cidForOperation is callable and produces a base32 multibase CID', () => {
    expect(typeof cidForOperation).toBe('function');
    expect(cidForOperation({ hello: 'world' })).toMatch(/^b[a-z2-7]+$/);
  });

  it('namespaceFragment formats the canonical fragment', () => {
    expect(namespaceFragment(0)).toBe('namespace_0');
    expect(namespaceFragment(42)).toBe('namespace_42');
  });

  it('add composers are exported as functions', () => {
    expect(typeof composeNamespaceUpdate).toBe('function');
    expect(typeof composeAndSignNamespaceUpdate).toBe('function');
  });

  it('disable composers are exported as functions (TN-IDENT-008)', () => {
    expect(typeof composeNamespaceDisable).toBe('function');
    expect(typeof composeAndSignNamespaceDisable).toBe('function');
  });

  it('PLC submitter surface is re-exported (TN-IDENT-006)', () => {
    expect(typeof submitPlcOperation).toBe('function');
    expect(typeof computePLCBackoff).toBe('function');
    expect(typeof PLCSubmitError).toBe('function'); // class
    expect(PLC_DEFAULT_MAX_ATTEMPTS).toBe(5);
    expect(PLC_DEFAULT_BACKOFF_BASE_MS).toBe(500);
  });

  it('computePLCBackoff produces the documented sequence', () => {
    expect([1, 2, 3, 4, 5].map((n) => computePLCBackoff(n))).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('namespace creation orchestrator surface is re-exported (TN-IDENT-007)', () => {
    expect(typeof createNamespace).toBe('function');
    expect(typeof nextAvailableNamespaceIndex).toBe('function');
  });

  it('nextAvailableNamespaceIndex finds the lowest-unused slot', () => {
    expect(nextAvailableNamespaceIndex({ verificationMethods: {} })).toBe(0);
    expect(
      nextAvailableNamespaceIndex({
        verificationMethods: { dina_signing: 'x', namespace_0: 'y', namespace_2: 'z' },
      }),
    ).toBe(1);
  });
});
