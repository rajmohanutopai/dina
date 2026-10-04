/**
 * A2A M0 (docs/A2A_GATEWAY_ARCHITECTURE.md §12): Core's pure decision
 * modules, and the parity checks that bind @dina/a2a's copies of shared
 * vocabulary to the sources of truth in Core and @dina/protocol.
 */

import {
  A2A_METHODS,
  DEFAULT_RESULT_SCHEMA,
  DINA_WORKFLOW_STATES,
  ENVELOPE_FAILURES,
  REFUSAL_VIEW,
  canonicalize,
  isValidCapabilityName,
  isValidListingRkey,
  parseEnvelopeData,
  parseInvocationEnvelope,
  projectAgentCard,
  type InvocationEnvelope,
  type ProjectionCapability,
  A2A_DISPATCH_TABLE,
  dinaErrorInfo,
} from '@dina/a2a';
import {
  CAPABILITY_REGISTRY,
  CATALOG_CAPABILITIES,
  getCatalogCapability,
  isCustomCapability,
  isPublicExposureAllowed,
  isValidServiceListingRkey,
  pinnedSchemaProblems,
  resolveCanonicalCapability,
} from '@dina/protocol';

import {
  ACTION_REGISTRY_REVISION,
  INBOUND_ACCESS_FAILURES,
  INBOUND_CARD_FAILURES,
  INBOUND_CLASSIFICATION_FAILURES,
  INGRESS_OUTCOME_CLASS,
  NORMALIZATION_FAILURES,
  WorkflowTaskState,
  bindSignedDispatch,
  canonicalDigest,
  capabilitySchemaHash,
  classifyInboundCapability,
  decideInboundClass,
  ingestRemoteResult,
  ingressFailureResponse,
  normalizeInvocation,
  validateAgainstSchema,
  validateSkillBinding,
  type PinnedSchemaPair,
} from '../../src';

describe('parity with the sources of truth', () => {
  it("@dina/a2a's workflow states are exactly Core's WorkflowTaskState", () => {
    expect([...DINA_WORKFLOW_STATES].sort()).toEqual(Object.values(WorkflowTaskState).sort());
  });

  it.each([
    'self',
    'a',
    'shop-1',
    'x.y',
    'A_b~c',
    '.',
    '..',
    '',
    'a/b',
    'a b',
    'a@b',
    'r'.repeat(512),
    'r'.repeat(513),
  ])('rkey %p: @dina/a2a agrees with @dina/protocol', (rkey) => {
    expect(isValidListingRkey(rkey)).toBe(isValidServiceListingRkey(rkey));
  });

  it('accepts every official capability name and alias as a skill capability', () => {
    for (const cap of CATALOG_CAPABILITIES) {
      expect(isValidCapabilityName(cap.id)).toBe(true);
      for (const alias of cap.aliases) expect(isValidCapabilityName(alias)).toBe(true);
    }
  });

  it.each(['com.acme.widget_price', 'org.example.x'])(
    'accepts the custom capability %s',
    (name) => {
      expect(isCustomCapability(name)).toBe(true);
      expect(isValidCapabilityName(name)).toBe(true);
    },
  );
});

describe('inbound action registry (design §5.4)', () => {
  it('resolves an alias to its canonical capability and catalog class', () => {
    expect(classifyInboundCapability('bus_eta')).toEqual({
      ok: true,
      canonical: 'eta_query',
      actionClass: 'read',
      publicExposureAllowed: true,
    });
  });

  it('reports a sensitive capability as not publicly exposable', () => {
    const out = classifyInboundCapability('appointment_status');
    expect(out.ok && out.publicExposureAllowed).toBe(false);
  });

  it.each([
    ['com.acme.widget_price', 'custom_capability'],
    ['com.dinakernel.commerce.request_quote', 'commerce_capability'],
    ['COM.DINAKERNEL.COMMERCE.REQUEST_QUOTE', 'commerce_capability'],
    ['no_such_capability', 'unknown_capability'],
  ])('refuses %s (%s)', (raw, reason) => {
    expect(classifyInboundCapability(raw)).toEqual({ ok: false, reason });
  });

  it('refuses a payment capability, always', () => {
    expect(
      decideInboundClass({
        normalized: 'pay_bill',
        canonical: 'pay_bill',
        actionClass: 'payment',
        publicExposureAllowed: true,
      }),
    ).toEqual({ ok: false, reason: 'payment_denied' });
  });

  it('pins a registry revision over every fact classification reads', () => {
    const recomputed = canonicalDigest(
      [...CAPABILITY_REGISTRY]
        .map((entry) => ({
          canonical: entry.canonical,
          aliases: [...entry.aliases].sort(),
          action_class: getCatalogCapability(entry.canonical)?.action_class ?? null,
          public_exposure_allowed: isPublicExposureAllowed(entry),
        }))
        .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0)),
    );
    expect(ACTION_REGISTRY_REVISION).toMatch(/^[0-9a-f]{64}$/);
    expect(ACTION_REGISTRY_REVISION).toBe(recomputed);
  });

  it('classifies every shipped catalog capability without error', () => {
    for (const cap of CATALOG_CAPABILITIES) {
      const out = classifyInboundCapability(cap.id);
      if (cap.action_class === 'payment')
        expect(out).toEqual({ ok: false, reason: 'payment_denied' });
      else expect(out.ok && out.actionClass).toBe(cap.action_class);
    }
  });
});

describe('outbound skill bindings (design §5.5)', () => {
  const base = {
    remoteAgentId: 'ra-1',
    cardHash: 'c'.repeat(64),
    skill: 'summarize',
    actionClass: 'read',
    credentialRef: 'cred-none-1',
  };

  it('accepts a binding with no result schema', () => {
    expect(validateSkillBinding(base)).toEqual({ ok: true, binding: base });
  });

  it.each(['read', 'quote', 'write', 'booking', 'agentic'])(
    'accepts the class %s',
    (actionClass) => {
      expect(validateSkillBinding({ ...base, actionClass }).ok).toBe(true);
    },
  );

  it('never accepts payment', () => {
    expect(validateSkillBinding({ ...base, actionClass: 'payment' })).toEqual({
      ok: false,
      reason: 'payment_unassignable',
    });
  });

  it.each([
    [{ actionClass: 'admin' }, 'action_class_invalid'],
    [{ cardHash: 'C'.repeat(64) }, 'card_hash_invalid'],
    [{ skill: '' }, 'skill_invalid'],
    [{ skill: ' padded' }, 'skill_invalid'],
    [{ skill: 'a\u0000b' }, 'skill_invalid'],
    [{ credentialRef: '' }, 'credential_ref_invalid'],
    [{ remoteAgentId: 'x'.repeat(129) }, 'remote_agent_id_invalid'],
  ])('refuses %p', (over, reason) => {
    expect(validateSkillBinding({ ...base, ...over })).toEqual({ ok: false, reason });
  });

  it('accepts a result schema built only from enforced keywords and annotations', () => {
    const resultSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Summary',
      type: 'object',
      required: ['summary'],
      additionalProperties: false,
      properties: {
        summary: { type: 'string', maxLength: 500, description: 'text' },
        kind: { oneOf: [{ const: 'short' }, { const: 'long' }] },
        tags: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['a', 'b'] } },
        code: { type: 'string', pattern: '^[A-Z]{2}$' },
        score: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      },
    };
    expect(validateSkillBinding({ ...base, resultSchema })).toEqual({
      ok: true,
      binding: { ...base, resultSchema },
    });
  });

  it('stores a pinned copy of the default envelope as no pinned schema', () => {
    const copy = JSON.parse(canonicalize(DEFAULT_RESULT_SCHEMA)) as Record<string, unknown>;
    expect(validateSkillBinding({ ...base, resultSchema: copy })).toEqual({
      ok: true,
      binding: base,
    });
  });

  it.each([
    [
      { type: 'object', properties: { d: { type: 'string', format: 'date' } } },
      'properties.d.format',
    ],
    [{ anyOf: [{ type: 'string' }] }, 'anyOf'],
    [{ $ref: '#/defs/x' }, '$ref'],
    [{ type: 'object', additionalProperties: { type: 'string' } }, 'additionalProperties'],
    [{ type: 'array', items: [{ type: 'string' }] }, 'items'],
    [{ oneOf: [{ type: 'string', minProperties: 1 }] }, 'oneOf[0].minProperties'],
    [{ type: 'object', properties: { secret: false } }, 'properties.secret'],
    [{ type: 'object', required: 'answer' }, 'required'],
    [{ type: 'object', properties: { a: { type: 5 } } }, 'properties.a.type'],
    [{ type: 'string', maxLength: '3' }, 'maxLength'],
    [{ enum: 'abc' }, 'enum'],
    [{ oneOf: {} }, 'oneOf'],
    [{ type: 'string', pattern: '(' }, 'pattern'],
    [{ type: 'number', exclusiveMinimum: true }, 'exclusiveMinimum'],
    [{ type: 'string', minLength: 5, maxLength: 1 }, 'minLength'],
  ])(
    'refuses a result schema the validator cannot enforce as written (%p)',
    (resultSchema, path) => {
      expect(validateSkillBinding({ ...base, resultSchema })).toEqual({
        ok: false,
        reason: `result_schema_unsupported:${path}`,
      });
    },
  );

  it('refuses an oversized result schema', () => {
    const big = { type: 'object', description: 'x'.repeat(70 * 1024) };
    expect(validateSkillBinding({ ...base, resultSchema: big })).toEqual({
      ok: false,
      reason: 'result_schema_too_large',
    });
  });
});

describe('schema validator: const, oneOf, pattern, exclusive bounds, and the keyword audit', () => {
  it('enforces const', () => {
    expect(validateAgainstSchema(1, { const: 1 }).ok).toBe(true);
    expect(validateAgainstSchema(2, { const: 1 }).ok).toBe(false);
    expect(validateAgainstSchema({ a: [1] }, { const: { a: [1] } }).ok).toBe(true);
  });

  it('enforces oneOf as exactly one', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateAgainstSchema('x', schema).ok).toBe(true);
    expect(validateAgainstSchema(true, schema)).toEqual({
      ok: false,
      error: '$: matches no oneOf branch',
    });
    const overlapping = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    expect(validateAgainstSchema(3, overlapping)).toEqual({
      ok: false,
      error: '$: matches several oneOf branches',
    });
  });

  it('enforces pattern by code point, unanchored, and fails closed on one that does not compile', () => {
    expect(validateAgainstSchema('ab12', { pattern: '[0-9]+' }).ok).toBe(true);
    expect(validateAgainstSchema('abc', { pattern: '^[0-9]+$' }).ok).toBe(false);
    expect(validateAgainstSchema('; rm -rf /', { type: 'string', pattern: '^[0-9]+$' }).ok).toBe(
      false,
    );
    expect(validateAgainstSchema('😀', { pattern: '^.$' }).ok).toBe(true);
    expect(validateAgainstSchema('x', { pattern: '(' }).ok).toBe(false);
    expect(validateAgainstSchema(5, { pattern: '^[0-9]+$' }).ok).toBe(true); // applies to strings only
  });

  it('enforces the exclusive bounds', () => {
    expect(validateAgainstSchema(0, { exclusiveMinimum: 0 }).ok).toBe(false);
    expect(validateAgainstSchema(0.5, { exclusiveMinimum: 0, exclusiveMaximum: 1 }).ok).toBe(true);
    expect(validateAgainstSchema(1, { exclusiveMaximum: 1 }).ok).toBe(false);
  });

  it('closes the D2D gap: a listing schema Brain enforces is enforced here too', () => {
    const schema = {
      type: 'object',
      properties: {
        route: { type: 'string', pattern: '^[0-9]+$' },
        n: { type: 'integer', exclusiveMinimum: 0 },
      },
    };
    expect(validateAgainstSchema({ route: '; rm -rf /', n: 1 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ route: '42', n: 0 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ route: '42', n: 1 }, schema).ok).toBe(true);
  });

  it('audits exactly the keywords the validator enforces (pinned_runtime profile)', () => {
    expect(
      pinnedSchemaProblems(
        { type: 'object', properties: { a: { type: 'string', pattern: 'x' } } },
        'pinned_runtime',
      ),
    ).toEqual([]);
    expect(
      pinnedSchemaProblems({ type: 'string', format: 'email' }, 'pinned_runtime').map(
        (p) => p.path,
      ),
    ).toEqual(['format']);
    // The plugin manifest contract is unchanged: pattern stays unenforceable there.
    expect(
      pinnedSchemaProblems({ type: 'string', pattern: 'x' }, 'plugin_manifest').map((p) => p.path),
    ).toEqual(['pattern']);
  });
});

describe('result ingest: sanitize BEFORE validate (design §6.5)', () => {
  it('validates the final bytes: a stripped zero-width character makes a const match', () => {
    const schema = { type: 'object', required: ['code'], properties: { code: { const: 'AB' } } };
    const out = ingestRemoteResult([{ data: { code: 'A​B' } }], schema);
    expect(out.ok && out.result.value).toEqual({ code: 'AB' });
    expect(out.ok && out.result.stripped).toBe(true);
  });

  it('validates the final bytes: a pinned const with a hidden character can never match', () => {
    const schema = { type: 'object', required: ['code'], properties: { code: { const: 'A​B' } } };
    expect(ingestRemoteResult([{ data: { code: 'A​B' } }], schema)).toEqual({
      ok: false,
      reason: 'result_schema_mismatch',
    });
  });

  it('validates the final bytes: stripping brings a value under maxLength', () => {
    const schema = { type: 'object', properties: { note: { type: 'string', maxLength: 2 } } };
    expect(ingestRemoteResult([{ data: { note: 'ab‮' } }], schema).ok).toBe(true);
  });

  it('accepts text and object data under the default envelope', () => {
    const out = ingestRemoteResult([{ text: 'done' }, { data: { eta: 5 } }]);
    expect(out.ok && out.result.mode).toBe('default');
    expect(out.ok && out.result.value).toEqual({
      version: 1,
      parts: [{ text: 'done' }, { data: { eta: 5 } }],
    });
  });

  it('refuses non-object data under the default envelope', () => {
    expect(ingestRemoteResult([{ data: [1, 2] }])).toEqual({
      ok: false,
      reason: 'result_schema_mismatch',
    });
  });

  it('refuses a raw part before any validation', () => {
    expect(ingestRemoteResult([{ raw: 'AQID' }])).toEqual({
      ok: false,
      reason: 'raw_part_refused',
    });
  });

  it('refuses a pinned schema that slipped past the binding audit', () => {
    expect(ingestRemoteResult([{ data: {} }], { type: 'object', minProperties: 1 })).toEqual({
      ok: false,
      reason: 'result_schema_unenforceable',
    });
  });

  it('treats a pinned copy of the default envelope as the default (text results still pass)', () => {
    const copy = JSON.parse(canonicalize(DEFAULT_RESULT_SCHEMA)) as Record<string, unknown>;
    const out = ingestRemoteResult([{ text: 'done' }], copy);
    expect(out.ok && out.result.mode).toBe('default');
  });

  it('refuses a __proto__ key in remote data instead of throwing', () => {
    const parts = JSON.parse('[{"data":{"__proto__":{"isAdmin":true}}}]') as unknown;
    expect(ingestRemoteResult(parts)).toEqual({ ok: false, reason: 'data_forbidden_key' });
  });

  it('digests the released value canonically (member order does not matter)', () => {
    const a = ingestRemoteResult([{ data: { x: 1, y: 2 } }]);
    const b = ingestRemoteResult([{ data: { y: 2, x: 1 } }]);
    expect(a.ok && b.ok && a.result.digest === b.result.digest).toBe(true);
    expect(a.ok && /^[0-9a-f]{64}$/.test(a.result.digest)).toBe(true);
  });
});

describe('ingress normalization (design §7.2 step 9)', () => {
  const schemas: PinnedSchemaPair = {
    params: {
      type: 'object',
      required: ['route'],
      properties: { route: { type: 'string', minLength: 1 }, stop: { type: 'string' } },
    },
    result: { type: 'object' },
    description: 'Arrival time.',
  };
  const envelopeOf = (data: Record<string, unknown>) => {
    const parsed = parseEnvelopeData(data);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.envelope;
  };
  const run = (data: Record<string, unknown>, extra: Partial<PinnedSchemaPair> = {}) =>
    normalizeInvocation({
      envelope: envelopeOf(data),
      canonicalCapability: 'eta_query',
      rkey: 'self',
      schemas: { ...schemas, ...extra },
    });

  it('accepts a call with no schema_hash (the extension is optional)', () => {
    const out = run({ skill: 'eta_query@self', params: { route: '42' } });
    expect(out.ok && out.normalized.skill).toBe('eta_query@self');
    expect(out.ok && out.normalized.schemaHash).toBe(capabilitySchemaHash(schemas));
  });

  it('accepts a matching recomputed or stored schema_hash, and refuses another', () => {
    expect(
      run({
        skill: 'eta_query',
        params: { route: '42' },
        schema_hash: capabilitySchemaHash(schemas),
      }).ok,
    ).toBe(true);
    expect(
      run(
        { skill: 'eta_query', params: { route: '42' }, schema_hash: 'b'.repeat(64) },
        { storedHash: 'b'.repeat(64) },
      ).ok,
    ).toBe(true);
    expect(
      run({ skill: 'eta_query', params: { route: '42' }, schema_hash: 'f'.repeat(64) }),
    ).toEqual({
      ok: false,
      reason: 'schema_version_mismatch',
    });
  });

  it('refuses params the pinned schema rejects', () => {
    expect(run({ skill: 'eta_query', params: { route: '' } })).toEqual({
      ok: false,
      reason: 'params_invalid',
    });
    expect(run({ skill: 'eta_query', params: {} })).toEqual({
      ok: false,
      reason: 'params_invalid',
    });
  });

  it('drops undeclared params, records them, and changes the post-hash only', () => {
    const plain = run({ skill: 'eta_query', params: { route: '42' } });
    const extra = run({ skill: 'eta_query', params: { route: '42', inject: 'x' } });
    if (!plain.ok || !extra.ok) throw new Error('expected success');
    expect(extra.normalized.params).toEqual({ route: '42' });
    expect(extra.normalized.strippedParams).toEqual(['inject']);
    expect(extra.normalized.postHash).toBe(plain.normalized.postHash);
    expect(extra.normalized.preHash).not.toBe(plain.normalized.preHash);
  });

  it('drops nothing when the schema declares no properties', () => {
    const out = run(
      { skill: 'eta_query', params: { anything: 1 } },
      { params: { type: 'object' } },
    );
    expect(out.ok && out.normalized.params).toEqual({ anything: 1 });
  });

  it('refuses a params schema with a keyword the validator would skip', () => {
    const out = run(
      { skill: 'eta_query', params: { route: '42' } },
      { params: { type: 'object', properties: { route: { type: 'string', format: 'uri' } } } },
    );
    expect(out).toEqual({ ok: false, reason: 'schema_unenforceable' });
  });

  it('refuses params carrying __proto__ even if an envelope reached it unchecked', () => {
    const envelope: InvocationEnvelope = {
      skill: { capability: 'eta_query' },
      skillText: 'eta_query',
      params: JSON.parse('{"route":"42","__proto__":{"x":1}}') as InvocationEnvelope['params'],
    };
    expect(
      normalizeInvocation({ envelope, canonicalCapability: 'eta_query', rkey: 'self', schemas }),
    ).toEqual({ ok: false, reason: 'params_invalid' });
  });
});

describe('ingress failure classes (design §7.2: steps 1–4 protocol error, 7–9 REJECTED)', () => {
  it('classifies every envelope, registry, access, normalization and card-bound reason', () => {
    const every = [
      ...ENVELOPE_FAILURES,
      ...INBOUND_CLASSIFICATION_FAILURES,
      ...INBOUND_ACCESS_FAILURES,
      ...NORMALIZATION_FAILURES,
      ...INBOUND_CARD_FAILURES,
    ];
    expect(Object.keys(INGRESS_OUTCOME_CLASS).sort()).toEqual([...every].sort());
  });

  // TCK CORE-SEND-003 (spec §3.1.1): a media type Dina does not read is ContentTypeNotSupportedError
  const CONTENT_TYPE = new Set(['no_data_part', 'raw_part_refused', 'url_part_refused']);
  it.each([...ENVELOPE_FAILURES])(
    'envelope failure %s is a protocol error naming its reason: -32005 for content Dina does not read, else -32602',
    (reason) => {
      const out = ingressFailureResponse(reason);
      expect(out.kind).toBe('protocol_error');
      expect(out.kind === 'protocol_error' && out.error.code).toBe(CONTENT_TYPE.has(reason) ? -32005 : -32602);
      expect(out.kind === 'protocol_error' && dinaErrorInfo(out.error)?.reason).toBe(reason);
    },
  );

  it.each([...INBOUND_CLASSIFICATION_FAILURES, ...INBOUND_ACCESS_FAILURES, ...NORMALIZATION_FAILURES, ...INBOUND_CARD_FAILURES])(
    'refusal %s collapses to the one REJECTED view',
    (reason) => {
      const out = ingressFailureResponse(reason);
      expect(out).toEqual({ kind: 'rejected', view: REFUSAL_VIEW, reason });
      expect(REFUSAL_VIEW.state).toBe('TASK_STATE_REJECTED');
    },
  );
});

describe('dispatch binding (design §5.1)', () => {
  const rpcPath = '/rpc';
  const body = (method: string, params: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const bind = (over: Partial<Parameters<typeof bindSignedDispatch>[0]>) =>
    bindSignedDispatch({
      signedMethod: 'POST',
      signedPath: rpcPath,
      signedQuery: '',
      rpcPath,
      rawBody: body('GetTask', { id: 't1' }),
      internalMethod: 'POST',
      internalRouteTemplate: '/v1/a2a/ingress/tasks/:extId/get',
      routeParams: { extId: 't1' },
      ...over,
    });

  it('maps every A2A method to its own route under the ingress prefix (M3: streaming too)', () => {
    expect(Object.keys(A2A_DISPATCH_TABLE).sort()).toEqual([...A2A_METHODS].sort());
    for (const route of Object.values(A2A_DISPATCH_TABLE)) expect(route.path.startsWith('/v1/a2a/ingress/')).toBe(true);
    expect(A2A_DISPATCH_TABLE.SendStreamingMessage.path).toBe('/v1/a2a/ingress/message/stream');
    expect(A2A_DISPATCH_TABLE.SubscribeToTask.path).toBe('/v1/a2a/ingress/tasks/:extId/subscribe');
  });

  it('routes every method as a POST, so the signed body always reaches Core', () => {
    const routes = Object.values(A2A_DISPATCH_TABLE);
    expect(routes.every((r) => r.method === 'POST')).toBe(true);
    expect(new Set(routes.map((r) => r.path)).size).toBe(routes.length);
  });

  it('refuses a body with two method members rather than reading the last', () => {
    const rawBody =
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","method":"CancelTask","params":{"id":"t1"}}';
    expect(bind({ rawBody })).toEqual({ ok: false, reason: 'malformed_body' });
  });

  it('binds the A2A-Version request parameter and refuses any other signed query', () => {
    const out = bind({ signedQuery: 'A2A-Version=1.0' });
    expect(out.ok && out.versionParameter).toBe('1.0');
    expect(bind({ signedQuery: 'debug=1' })).toEqual({ ok: false, reason: 'query_not_allowed' });
    expect(bind({ signedQuery: 'A2A-Version=1.0&x=1' })).toEqual({
      ok: false,
      reason: 'query_not_allowed',
    });
  });

  it('binds a matching call', () => {
    const out = bind({});
    expect(out.ok && out.request.method).toBe('GetTask');
  });

  it('refuses a cross-operation substitution (signed GetTask, executed CancelTask)', () => {
    expect(bind({ internalRouteTemplate: '/v1/a2a/ingress/tasks/:extId/cancel' })).toEqual({
      ok: false,
      reason: 'operation_mismatch',
    });
  });

  it('refuses a cross-task substitution (signed t1, executed t2)', () => {
    expect(bind({ routeParams: { extId: 't2' } })).toEqual({ ok: false, reason: 'id_mismatch' });
  });

  it('refuses an extra route parameter', () => {
    expect(bind({ routeParams: { extId: 't1', configId: 'c' } })).toEqual({
      ok: false,
      reason: 'id_mismatch',
    });
  });

  // TCK interop: the endpoint with a trailing slash is the same endpoint (`isA2ARpcPath`)
  it('accepts a signature over the endpoint with a trailing slash, and over no other variant', () => {
    const at = (signedPath: string) => bind({ signedPath }).ok;
    expect(at(rpcPath)).toBe(true);
    expect(at(`${rpcPath}/`)).toBe(true);
    expect([at(`${rpcPath}//`), at(`${rpcPath}/x`), at(rpcPath.slice(0, -1)), at(`${rpcPath}.`)]).toEqual([false, false, false, false]);
  });

  it('refuses a signature over another external request', () => {
    expect(bind({ signedPath: '/other' })).toEqual({ ok: false, reason: 'external_mismatch' });
    expect(bind({ signedMethod: 'GET' })).toEqual({ ok: false, reason: 'external_mismatch' });
    expect(bind({ internalMethod: 'GET' })).toEqual({ ok: false, reason: 'operation_mismatch' });
  });

  it('binds both ids of a push-config call', () => {
    const out = bind({
      rawBody: body('GetTaskPushNotificationConfig', { taskId: 't1', id: 'c1' }),
      internalRouteTemplate: '/v1/a2a/ingress/push-configs/:extId/:configId/get',
      routeParams: { extId: 't1', configId: 'c1' },
    });
    expect(out.ok).toBe(true);
  });

  it.each([
    ['a streaming body sent to another door', body('SendStreamingMessage', {}), 'operation_mismatch'],
    ['a body that is not JSON-RPC', '{"x":1}', 'malformed_body'],
    ['a missing task id', body('GetTask', {}), 'id_missing'],
  ])('refuses %s', (_name, rawBody, reason) => {
    expect(bind({ rawBody })).toEqual({ ok: false, reason });
  });
});

describe('card projection over the shipped catalog (design §7.1, §7.6)', () => {
  const caps: ProjectionCapability[] = CATALOG_CAPABILITIES.map((def) => {
    const cls = classifyInboundCapability(def.id);
    const cap: ProjectionCapability = {
      capability: def.id,
      canonical: resolveCanonicalCapability(def.id),
      actionClass: cls.ok ? cls.actionClass : null,
      publicExposureAllowed: cls.ok && cls.publicExposureAllowed,
      schemasEnforceable:
        def.params_schema !== undefined &&
        pinnedSchemaProblems(def.params_schema, 'pinned_runtime').length === 0,
      executor: 'tier1',
      displayName: def.display_name,
      description: def.short_description,
      tags: [...def.category_ids],
    };
    // A capability that ships no schema pair stays off the card (no_schema_pair).
    if (def.params_schema !== undefined && def.result_schema !== undefined) {
      const params = def.params_schema as unknown as Record<string, never>;
      cap.paramsSchema = params;
      cap.schemaHash = capabilitySchemaHash({
        params,
        result: def.result_schema as unknown as Record<string, unknown>,
        description: def.short_description,
      });
    }
    return cap;
  });
  const out = projectAgentCard({
    nodeDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    name: 'Catalog node',
    description: 'Every official capability.',
    version: '1',
    interfaceUrl: 'https://a2a.example.org/rpc',
    securitySchemes: {},
    securityRequirements: [],
    flags: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    listings: [
      {
        rkey: 'self',
        status: 'active',
        discoverability: 'public',
        surface: 'services',
        capabilities: caps,
      },
    ],
  });

  it('projects only publicly exposable, non-payment capabilities', () => {
    if (!out.ok) throw new Error('expected a card');
    for (const s of out.skills) {
      const cls = classifyInboundCapability(s.canonical);
      expect(cls.ok && cls.publicExposureAllowed).toBe(true);
    }
  });

  it('gives every projected skill a standard-field example that Core accepts (control plane §18.4)', () => {
    if (!out.ok) throw new Error('expected a card');
    let checked = 0;
    for (const s of out.skills) {
      const example = s.skill.examples?.[0];
      if (example === undefined) continue; // a schema the sampler cannot satisfy carries no sample
      const parsed = parseInvocationEnvelope([
        { data: JSON.parse(example) as Record<string, unknown> },
      ]);
      if (!parsed.ok) throw new Error(`${s.skill.id}: ${parsed.reason}`);
      expect(validateAgainstSchema(parsed.envelope.params, s.paramsSchema).ok).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
