/**
 * The trust surface (§10.7, §11.3 — WS-10.3 / WS-10.6).
 *
 * These routes are pure decisions over evidence a caller supplies, so the
 * route-level properties are about what they REFUSE to default: an absent
 * official catalog read as empty would make every additive check pass, and an
 * absent AppView answer read as agreement would make every consensus
 * unanimous.
 */

import { INHERIT_STANDING_BP } from '../../../src/commerce/relationship_resolver';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

const OWNER_CAP = 'test-owner-capability-secret';
const SCHEMA = 'sha256:' + 'a'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

function post(path: string, body: Record<string, unknown>, callerType = 'owner'): CoreRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== '' ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

let router: CoreRouter;

beforeEach(() => {
  setNodeDID('did:plc:chairmaker99');
  installCommerceRuntime({
    availability: () => ({ available: true }),
  } as unknown as CommerceRuntime);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  clearPairingState();
});

const PATHS = [
  '/v1/commerce/relationships/resolve',
  '/v1/commerce/capabilities/promote',
  '/v1/commerce/capabilities/resolve',
];

describe('every trust route is owner-only', () => {
  it.each(PATHS)('%s refuses a non-owner caller', async (path) => {
    for (const callerType of ['agent', 'plugin', 'service', 'device']) {
      expect((await router.handle(post(path, {}, callerType))).status).toBe(403);
    }
  });

  it('a router registered with no capability refuses the owner too', async () => {
    const unguarded = new CoreRouter();
    registerCommerceRoutes(unguarded);
    for (const path of PATHS) {
      expect((await unguarded.handle(post(path, {}))).status).toBe(403);
    }
  });
});

describe('resolving plural AppView answers (§10.7)', () => {
  const edge = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    subject_key: 'gtin:05012345678900',
    relationship: 'variant_of',
    object_key: 'gtin:05012345678917',
    confidence_bp: 9500,
    ...overrides,
  });

  it('returns the consensus floor and the three verdicts with each edge', async () => {
    const response = await router.handle(
      post('/v1/commerce/relationships/resolve', {
        answers: [
          { appview_did: 'did:web:a', edges: [edge({ confidence_bp: 9800 })] },
          { appview_did: 'did:web:b', edges: [edge({ confidence_bp: 9500 })] },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      edges: [
        {
          subject_key: 'gtin:05012345678900',
          relationship: 'variant_of',
          object_key: 'gtin:05012345678917',
          confidence_bp: 9500,
          supporting_views: 2,
          consulted_views: 2,
          contested: false,
          // The verdicts travel WITH the edge so no client re-derives them
          // from the number against its own constant.
          may_show_as_related: true,
          may_inherit_standing: true,
          may_authorize_substitution: true,
        },
      ],
      disagreements: [],
    });
  });

  it('exposes a disagreement with an owner-readable headline', async () => {
    const response = await router.handle(
      post('/v1/commerce/relationships/resolve', {
        answers: [
          { appview_did: 'did:web:a', edges: [edge()] },
          { appview_did: 'did:web:b', edges: [edge({ object_key: 'gtin:05099999999999' })] },
        ],
      }),
    );
    const body = response.body as { disagreements: { kind: string; headline: string }[] };
    const conflict = body.disagreements.find((d) => d.kind === 'conflicting_object');
    expect(conflict).toBeDefined();
    expect(conflict?.headline).toContain('disagree');
  });

  it('caps an edge only one view reports, through the route', async () => {
    const response = await router.handle(
      post('/v1/commerce/relationships/resolve', {
        answers: [
          { appview_did: 'did:web:a', edges: [edge({ confidence_bp: 9900 })] },
          { appview_did: 'did:web:b', edges: [] },
        ],
      }),
    );
    const body = response.body as {
      edges: { confidence_bp: number; may_inherit_standing: boolean }[];
    };
    expect(body.edges[0]?.confidence_bp).toBe(INHERIT_STANDING_BP - 1);
    expect(body.edges[0]?.may_inherit_standing).toBe(false);
  });

  it('refuses a malformed answer rather than treating it as silence', async () => {
    // A malformed answer read as "this view reported nothing" would turn a
    // parsing bug into a partial-support finding, which reads as a real
    // disagreement between real indexes.
    for (const answers of [
      [{ appview_did: '', edges: [] }],
      [{ appview_did: 'did:web:a' }],
      [{ appview_did: 'did:web:a', edges: [{ subject_key: 'x' }] }],
      [{ appview_did: 'did:web:a', edges: [edge({ confidence_bp: 'high' })] }],
      ['not an object'],
    ]) {
      const response = await router.handle(post('/v1/commerce/relationships/resolve', { answers }));
      expect(response.status).toBe(400);
    }
  });

  it('requires answers to be an array', async () => {
    expect((await router.handle(post('/v1/commerce/relationships/resolve', {}))).status).toBe(400);
  });

  it('reads a missing disputed flag as false', async () => {
    const response = await router.handle(
      post('/v1/commerce/relationships/resolve', {
        answers: [{ appview_did: 'did:web:a', edges: [edge()] }],
      }),
    );
    expect((response.body as { edges: { contested: boolean }[] }).edges[0]?.contested).toBe(false);
  });
});

describe('promotion (§11.3)', () => {
  const observation = (providerDid: string): Record<string, unknown> => ({
    providerDid,
    schemaHash: SCHEMA,
    answeredCount: 50,
    failureCodes: ['refused', 'unavailable'],
    cardFallbackRendered: true,
    firstSeenAtMs: Date.now() - 40 * DAY_MS,
    lastSeenAtMs: Date.now(),
  });

  const evidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    customCapabilityId: 'com.dinakernel.commerce.quote',
    proposedOfficialId: 'commerce.quote',
    observations: [observation('did:plc:one'), observation('did:plc:two')],
    actionClass: 'read',
    privacyClass: 'business_public',
    publicExposure: 'listed providers answer any buyer',
    subjectAuthorization: 'the buyer must hold a quote grant',
    observedRateLimitPerMinute: 30,
    ...overrides,
  });

  it('answers eligible with the catalog the owner would end up with', async () => {
    const response = await router.handle(
      post('/v1/commerce/capabilities/promote', { evidence: evidence(), official: [] }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      eligible: true,
      official: { capabilityId: 'commerce.quote', aliases: ['com.dinakernel.commerce.quote'] },
      catalog: [{ capabilityId: 'commerce.quote' }],
    });
  });

  it('answers 409 with every finding when it has not earned it', async () => {
    const response = await router.handle(
      post('/v1/commerce/capabilities/promote', {
        evidence: evidence({ observations: [observation('did:plc:one')], actionClass: '' }),
        official: [],
      }),
    );
    expect(response.status).toBe(409);
    const body = response.body as { findings: { refusal: string }[] };
    expect(body.findings.map((f) => f.refusal)).toEqual(
      expect.arrayContaining(['single_provider', 'class_not_declared']),
    );
  });

  it('REFUSES a missing catalog rather than defaulting it to empty', async () => {
    // An absent catalog read as "nothing is official yet" makes every additive
    // check pass, and the additive check is the one §11.3 cares most about.
    const response = await router.handle(
      post('/v1/commerce/capabilities/promote', { evidence: evidence() }),
    );
    expect(response.status).toBe(400);
  });

  it('requires the evidence', async () => {
    expect(
      (await router.handle(post('/v1/commerce/capabilities/promote', { official: [] }))).status,
    ).toBe(400);
  });

  it('refuses a promotion that would reinterpret an existing capability', async () => {
    const response = await router.handle(
      post('/v1/commerce/capabilities/promote', {
        evidence: evidence({ actionClass: 'effect' }),
        official: [
          {
            capabilityId: 'commerce.quote',
            schemaHash: SCHEMA,
            actionClass: 'read',
            privacyClass: 'business_public',
            aliases: [],
          },
        ],
      }),
    );
    expect(response.status).toBe(409);
    expect((response.body as { findings: { refusal: string }[] }).findings[0]?.refusal).toBe(
      'would_reinterpret_existing',
    );
  });
});

describe('resolving a capability id through its aliases', () => {
  const official = [
    {
      capabilityId: 'commerce.quote',
      schemaHash: SCHEMA,
      actionClass: 'read',
      privacyClass: 'business_public',
      aliases: ['com.dinakernel.commerce.quote'],
    },
  ];

  it('says when an id was translated', async () => {
    const response = await router.handle(
      post('/v1/commerce/capabilities/resolve', {
        official,
        capability_id: 'com.dinakernel.commerce.quote',
      }),
    );
    // §11.3's "never silently reinterpreted" has a read side.
    expect(response.body).toEqual({ capability_id: 'commerce.quote', via_alias: true });
  });

  it('says when it was not', async () => {
    const response = await router.handle(
      post('/v1/commerce/capabilities/resolve', { official, capability_id: 'commerce.quote' }),
    );
    expect(response.body).toEqual({ capability_id: 'commerce.quote', via_alias: false });
  });

  it('answers 404 for an id nobody claims', async () => {
    const response = await router.handle(
      post('/v1/commerce/capabilities/resolve', { official, capability_id: 'commerce.nothing' }),
    );
    expect(response.status).toBe(404);
  });

  it('requires both the catalog and the id', async () => {
    expect(
      (await router.handle(post('/v1/commerce/capabilities/resolve', { official }))).status,
    ).toBe(400);
    expect(
      (await router.handle(post('/v1/commerce/capabilities/resolve', { capability_id: 'x' })))
        .status,
    ).toBe(400);
  });
});
