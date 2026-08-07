/**
 * Extension-operation registry + gate (§3.4, conformance §25.2):
 * deny-before-validation for undeclared operations, single-owner
 * names, pinned schema digests.
 */

import {
  ExtensionOperationRegistry,
  checkHostOperationInvocation,
} from '../../src/plugins/extension_ops';

const APPVIEW_SEARCH = {
  operationName: 'commerce.appview_search',
  paramsSchema: { type: 'object', properties: { queryText: { type: 'string' } } },
  resultSchema: { type: 'object' },
  adapterVersion: '0.1.0',
  requiredFeature: 'commerce-host-ops-v1',
  actionClass: 'read' as const,
};

describe('ExtensionOperationRegistry', () => {
  it('registers once and pins schema digests', () => {
    const registry = new ExtensionOperationRegistry();
    const registered = registry.register(APPVIEW_SEARCH);
    expect(registered.paramsSchemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(registered.resultSchemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(registered.paramsSchemaDigest).not.toBe(registered.resultSchemaDigest);
    expect(registry.list()).toHaveLength(1);
  });

  it('two adapters cannot claim one name', () => {
    const registry = new ExtensionOperationRegistry();
    registry.register(APPVIEW_SEARCH);
    expect(() => registry.register({ ...APPVIEW_SEARCH, adapterVersion: '0.2.0' })).toThrow(
      /already registered/,
    );
  });

  it('rejects malformed names — registration is code-shipped, not data-driven', () => {
    const registry = new ExtensionOperationRegistry();
    expect(() => registry.register({ ...APPVIEW_SEARCH, operationName: 'BAD NAME' })).toThrow(
      /invalid operation name/,
    );
  });
});

describe('checkHostOperationInvocation (deny before validation, §25.2)', () => {
  const registry = new ExtensionOperationRegistry();
  registry.register(APPVIEW_SEARCH);

  it('denies an operation the consented capability never declared — even a registered one', () => {
    const result = checkHostOperationInvocation(
      { id: 'com.example.buyer.find', host_operations: [] },
      'commerce.appview_search',
      registry,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('operation_not_declared');
  });

  it('denies when the capability carries no host_operations at all', () => {
    const result = checkHostOperationInvocation(
      { id: 'com.example.buyer.find' },
      'commerce.appview_search',
      registry,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('operation_not_declared');
  });

  it('denies a declared but unshipped operation', () => {
    const result = checkHostOperationInvocation(
      { id: 'com.example.buyer.find', host_operations: ['commerce.future_op'] },
      'commerce.future_op',
      registry,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('operation_unregistered');
  });

  it('allows a declared, registered operation and hands back the pinned definition', () => {
    const result = checkHostOperationInvocation(
      { id: 'com.example.buyer.find', host_operations: ['commerce.appview_search'] },
      'commerce.appview_search',
      registry,
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.operation.actionClass).toBe('read');
      expect(result.operation.paramsSchemaDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
