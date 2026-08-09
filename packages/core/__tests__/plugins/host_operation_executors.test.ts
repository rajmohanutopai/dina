/**
 * The three typed host operations §3.4 names and WS-3.5 left open.
 *
 * ONE RULE RUNS THROUGH ALL OF THEM: the authority comes from the install and
 * the node, never from the params. A runner that could name the sender of a
 * D2D message, the supplier a catalog publishes under, or the install a
 * credential belongs to would be choosing its own authority through a payload
 * — which is what typed host operations exist to prevent. Each suite below
 * tests that its executor REFUSES the field rather than ignoring it.
 */

import { CredentialBroker } from '../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../src/commerce/credential_store';
import {
  makeConnectorBrokerOperation,
  makeD2DSendOperation,
  makePublicationCandidateOperation,
} from '../../src/plugins/host_operation_executors';

import type { HostOperationContext } from '../../src/plugins/host_operations';

const CTX = {
  proposalId: 'prop-1',
  installId: 'install-1',
  capabilityId: 'cap-1',
  operationName: 'op',
};

const ctx = (params: unknown): HostOperationContext => ({ ...CTX, params });

describe('d2d_send — the sender is this node', () => {
  const make = (options: { recipients?: string[]; send?: () => Promise<void> } = {}) => {
    const sent: { toDid: string; body: unknown }[] = [];
    const executor = makeD2DSendOperation({
      send: async (args) => {
        sent.push(args);
        if (options.send !== undefined) await options.send();
      },
      permittedRecipients: () => options.recipients ?? ['did:plc:chairmaker'],
    });
    return { executor, sent };
  };

  it('sends to a permitted recipient', async () => {
    const { executor, sent } = make();
    const outcome = await executor(ctx({ to_did: 'did:plc:chairmaker', body: { hello: true } }));
    expect(outcome).toEqual({ kind: 'completed', result: { sent_to: 'did:plc:chairmaker' } });
    expect(sent).toEqual([{ toDid: 'did:plc:chairmaker', body: { hello: true } }]);
  });

  it('REFUSES a params-named sender rather than ignoring it', async () => {
    // Silently overriding would leave the runner believing it chose the
    // sender until something depended on that belief.
    const { executor, sent } = make();
    const outcome = await executor(
      ctx({ to_did: 'did:plc:chairmaker', from_did: 'did:plc:someone-else', body: {} }),
    );
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(sent).toEqual([]);
  });

  it('refuses a recipient this install may not reach', async () => {
    const { executor, sent } = make({ recipients: ['did:plc:chairmaker'] });
    const outcome = await executor(ctx({ to_did: 'did:plc:stranger', body: {} }));
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('stranger') });
    // Without this check one permitted send would be a channel to every DID
    // the node can resolve.
    expect(sent).toEqual([]);
  });

  it('refuses a malformed request before touching the sender', async () => {
    const { executor, sent } = make();
    for (const params of [null, 'text', {}, { to_did: '' }, { to_did: 'did:plc:chairmaker' }]) {
      expect(await executor(ctx(params))).toMatchObject({ kind: 'failed' });
    }
    expect(sent).toEqual([]);
  });

  it('lets a throw AFTER the send become the dispatcher problem it is', async () => {
    // Everything decidable is decided before the send. From there a throw
    // means the bytes may have left, and the DISPATCHER settles it unknown —
    // this executor must not swallow it into `failed`.
    const { executor } = make({
      send: async () => {
        throw new Error('socket died');
      },
    });
    await expect(executor(ctx({ to_did: 'did:plc:chairmaker', body: {} }))).rejects.toThrow(
      'socket died',
    );
  });
});

describe('publication_candidate — Core validates, and does not publish', () => {
  const make = (
    options: { supplier?: string | null; mayPublish?: boolean; findings?: { refusal: string; detail: string }[] } = {},
  ) =>
    makePublicationCandidateOperation({
      // `'supplier' in options` rather than `??`, because the two cases this
      // must distinguish are "not specified" and "explicitly null" — and `??`
      // collapses them, so the null case silently tested the default.
      supplierDid: () => ('supplier' in options ? options.supplier ?? null : 'did:plc:chairmaker'),
      mayPublish: () => options.mayPublish !== false,
      validateCandidate: () => options.findings ?? [],
    });

  it('validates a clean candidate and says so — without publishing', async () => {
    const outcome = await make()(ctx({ candidate: { items: [] } }));
    // `validated`, not `published`. Publication advances a chain buyers
    // follow and is the owner's act.
    expect(outcome).toEqual({
      kind: 'completed',
      result: { validated: true, supplier_did: 'did:plc:chairmaker' },
    });
  });

  it('refuses an install that is not the supplier', async () => {
    const outcome = await make({ mayPublish: false })(ctx({ candidate: {} }));
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('install-1') });
  });

  it('fails closed before this node has an identity', async () => {
    for (const supplier of [null, '']) {
      const outcome = await make({ supplier })(ctx({ candidate: {} }));
      expect(outcome).toMatchObject({ kind: 'failed' });
    }
  });

  it('REFUSES a params-named supplier', async () => {
    // A candidate naming another supplier would publish under somebody else's
    // scope, and a `manufacturer_sku` only means something scoped to its
    // issuer.
    const outcome = await make()(
      ctx({ candidate: {}, supplier_did: 'did:plc:rival' }),
    );
    expect(outcome).toMatchObject({ kind: 'failed' });
  });

  it('reports EVERY finding, not the first', async () => {
    const outcome = await make({
      findings: [
        { refusal: 'credential_in_field', detail: 'items[0].note' },
        { refusal: 'unknown_field', detail: 'items[1].secret' },
      ],
    })(ctx({ candidate: {} }));
    expect(outcome).toMatchObject({ kind: 'failed' });
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('credential_in_field');
      expect(outcome.error).toContain('unknown_field');
    }
  });

  it('refuses a request with no candidate', async () => {
    for (const params of [null, 'text', {}]) {
      expect(await make()(ctx(params))).toMatchObject({ kind: 'failed' });
    }
  });
});

describe('connector_broker — the install comes from the proposal', () => {
  function brokerFor(options: { installId?: string; fails?: boolean } = {}): CredentialBroker {
    const store = new InMemoryCredentialStore();
    store.rotate({
      resource: 'erp.primary',
      installId: options.installId ?? 'install-1',
      operations: ['submit_purchase_order'],
      material: 'sk-live-erp-token-0123456789abcd',
      nowMs: 1_000,
    });
    return new CredentialBroker({
      store,
      executors: () => ({
        'erp.primary:submit_purchase_order': async () =>
          options.fails === true
            ? { ok: false, error: 'HTTP 500' }
            : { ok: true, result: { external_ref: 'SO-1' } },
      }),
    });
  }

  const params = {
    resource: 'erp.primary',
    operation: 'submit_purchase_order',
    operation_params: { po: 'PO-1' },
  };

  it('performs the operation and returns its result', async () => {
    const executor = makeConnectorBrokerOperation({ broker: () => brokerFor() });
    expect(await executor(ctx(params))).toEqual({
      kind: 'completed',
      result: { external_ref: 'SO-1' },
    });
  });

  it('REFUSES a params-named install', async () => {
    // The broker trusts whatever install id it is handed, so this is the ONE
    // check it cannot make for itself: a runner naming its own install would
    // spend another install's credential.
    const executor = makeConnectorBrokerOperation({ broker: () => brokerFor() });
    const outcome = await executor(ctx({ ...params, install_id: 'install-1' }));
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('install') });
  });

  it('uses the PROPOSAL install, so another install is refused by the broker', async () => {
    const executor = makeConnectorBrokerOperation({
      broker: () => brokerFor({ installId: 'somebody-else' }),
    });
    const outcome = await executor(ctx(params));
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('install_not_permitted'),
    });
  });

  it('maps a pre-network refusal to failed and a wire failure to unknown', async () => {
    // "You may not" and "it may have happened" lead an operator to opposite
    // next steps, so the distinction survives into §3.4's outcomes.
    const undeclared = makeConnectorBrokerOperation({ broker: () => brokerFor() });
    expect(await undeclared(ctx({ ...params, operation: 'wire_money' }))).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('operation_not_declared'),
    });

    const failed = makeConnectorBrokerOperation({ broker: () => brokerFor({ fails: true }) });
    expect(await failed(ctx(params))).toMatchObject({
      kind: 'outcome_unknown',
      detail: expect.stringContaining('operation_failed'),
    });
  });

  it('fails closed when the node has no broker', async () => {
    const executor = makeConnectorBrokerOperation({ broker: () => null });
    expect(await executor(ctx(params))).toMatchObject({ kind: 'failed' });
  });

  it('refuses a malformed request', async () => {
    const executor = makeConnectorBrokerOperation({ broker: () => brokerFor() });
    for (const bad of [null, 'text', {}, { resource: 'erp.primary' }, { operation: 'x' }]) {
      expect(await executor(ctx(bad))).toMatchObject({ kind: 'failed' });
    }
  });

  it('defaults absent operation params to an empty object rather than undefined', async () => {
    let seen: unknown = 'never called';
    const store = new InMemoryCredentialStore();
    store.rotate({
      resource: 'erp.primary',
      installId: 'install-1',
      operations: ['submit_purchase_order'],
      material: 'sk-live-erp-token-0123456789abcd',
      nowMs: 1_000,
    });
    const executor = makeConnectorBrokerOperation({
      broker: () =>
        new CredentialBroker({
          store,
          executors: () => ({
            'erp.primary:submit_purchase_order': async ({ params: p }) => {
              seen = p;
              return { ok: true, result: null };
            },
          }),
        }),
    });
    await executor(ctx({ resource: 'erp.primary', operation: 'submit_purchase_order' }));
    // `undefined` would reach `paramsCarryCredential` as a non-object and be
    // read as "no credential" by luck rather than by rule.
    expect(seen).toEqual({});
  });
});
