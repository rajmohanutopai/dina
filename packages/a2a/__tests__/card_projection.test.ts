import {
  A2A_LIMITS,
  DINA_A2A_EXTENSION_URI,
  MAX_ID_LENGTH,
  SAMPLE_MAX_DEPTH,
  SAMPLE_MAX_EXAMPLE_BYTES,
  SAMPLE_MAX_ITEMS,
  SAMPLE_MAX_LENGTH,
  SAMPLE_MAX_VALUES,
  exclusionReason,
  parseEnvelopeData,
  projectAgentCard,
  projectSkills,
  sampleFromSchema,
  skillShareFits,
  canonicalize,
  utf8Bytes,
  validateAgentCardShape,
  type CardAudience,
  type CardProjectionInput,
  type ProjectionCapability,
  type ProjectionListing,
} from '../src';

const ETA_SCHEMA = {
  type: 'object',
  required: ['route', 'stop'],
  properties: {
    route: { type: 'string', minLength: 1 },
    stop: { type: 'string' },
    max: { type: 'integer', minimum: 1 },
  },
};

const cap = (over: Partial<ProjectionCapability> = {}): ProjectionCapability => ({
  capability: 'eta_query',
  canonical: 'eta_query',
  actionClass: 'read',
  publicExposureAllowed: true,
  paramsSchema: ETA_SCHEMA,
  schemaHash: 'a'.repeat(64),
  schemasEnforceable: true,
  executor: 'tier1',
  displayName: 'ETA / arrival time',
  description: 'Estimated arrival time for a transit route at a stop.',
  tags: ['transit'],
  ...over,
});

const capWithout = (key: keyof ProjectionCapability): ProjectionCapability =>
  Object.fromEntries(
    Object.entries(cap()).filter(([k]) => k !== key),
  ) as unknown as ProjectionCapability;

const listing = (over: Partial<ProjectionListing> = {}): ProjectionListing => ({
  rkey: 'self',
  status: 'active',
  discoverability: 'public',
  surface: 'services',
  capabilities: [cap()],
  ...over,
});

const input = (listings: ProjectionListing[]): CardProjectionInput => ({
  nodeDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
  name: 'Bus 42 Desk',
  description: 'Next-bus times.',
  version: '1',
  interfaceUrl: 'https://a2a.example.org/rpc',
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { bearer: {} } }],
  flags: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  listings,
});

describe('card projection inclusion rules (design §7.1)', () => {
  it.each([
    ['a draft listing', listing({ status: 'draft' }), cap(), 'listing_not_active'],
    ['a paused listing', listing({ status: 'paused' }), cap(), 'listing_not_active'],
    ['an unlisted listing', listing({ discoverability: 'unlisted' }), cap(), 'listing_not_public'],
    [
      'a known_only listing',
      listing({ discoverability: 'known_only' }),
      cap(),
      'listing_not_public',
    ],
    ['a Talk listing', listing({ surface: 'talk' }), cap(), 'listing_not_services'],
    [
      'a custom capability',
      listing(),
      cap({ capability: 'com.acme.thing', canonical: null }),
      'custom_capability',
    ],
    [
      'a commerce capability',
      listing(),
      cap({ capability: 'com.dinakernel.commerce.request_quote', canonical: null }),
      'commerce_capability',
    ],
    ['a payment capability', listing(), cap({ actionClass: 'payment' }), 'payment_class'],
    ['a capability with no class', listing(), cap({ actionClass: null }), 'no_action_class'],
    [
      'a sensitive capability',
      listing(),
      cap({ publicExposureAllowed: false }),
      'not_public_exposable',
    ],
    ['a schema-less capability', listing(), capWithout('paramsSchema'), 'no_schema_pair'],
    ['a capability with no hash at all', listing(), capWithout('schemaHash'), 'no_schema_pair'],
    ['a capability with no hash', listing(), cap({ schemaHash: '' }), 'no_schema_pair'],
    ['an executor-less capability', listing(), cap({ executor: null }), 'no_executor'],
  ])('leaves out %s', (_name, l, c, reason) => {
    expect(exclusionReason(l, c)).toBe(reason);
    expect(projectAgentCard(input([{ ...l, capabilities: [c] }]))).toEqual({
      ok: false,
      reason: 'no_projectable_skills',
    });
  });

  it('projects an eligible capability as an rkey-qualified skill', () => {
    const out = projectAgentCard(input([listing()]));
    if (!out.ok) throw new Error('expected a card');
    expect(out.card.skills.map((s) => s.id)).toEqual(['eta_query@self']);
    expect(validateAgentCardShape(out.card)).toBeNull();
  });

  it('uses the canonical name when a listing configures an alias', () => {
    const out = projectAgentCard(
      input([listing({ capabilities: [cap({ capability: 'bus_eta' })] })]),
    );
    expect(out.ok && out.card.skills[0]?.id).toBe('eta_query@self');
  });

  it('keeps one skill per listing and sorts them', () => {
    const out = projectAgentCard(
      input([
        listing({ rkey: 'west' }),
        listing({ rkey: 'east' }),
        listing({ rkey: 'gone', status: 'paused' }),
      ]),
    );
    expect(out.ok && out.card.skills.map((s) => s.id)).toEqual([
      'eta_query@east',
      'eta_query@west',
    ]);
  });

  it('never copies a field the card does not need (no Dina-field leakage)', () => {
    const leaky = {
      ...cap(),
      instruction: 'SECRET INSTRUCTION',
      mcpServer: 'internal-runner',
      pluginInstallId: 'install-123',
      persona: 'health',
    } as ProjectionCapability;
    const out = projectAgentCard(
      input([{ ...listing(), capabilities: [leaky], ownerNote: 'private' } as ProjectionListing]),
    );
    const text = JSON.stringify(out);
    for (const secret of [
      'SECRET INSTRUCTION',
      'internal-runner',
      'install-123',
      'health',
      'private',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('is deterministic', () => {
    const a = JSON.stringify(
      projectAgentCard(input([listing({ rkey: 'b' }), listing({ rkey: 'a' })])),
    );
    const b = JSON.stringify(
      projectAgentCard(input([listing({ rkey: 'a' }), listing({ rkey: 'b' })])),
    );
    expect(a).toBe(b);
  });
});

describe('call contract on the card (design §7.6)', () => {
  const out = projectAgentCard(input([listing()]));
  if (!out.ok) throw new Error('expected a card');
  const skill = out.card.skills[0];
  if (skill === undefined) throw new Error('expected a skill');

  it('carries the contract in the Dina extension, required:false', () => {
    const ext = out.card.capabilities.extensions?.[0];
    expect(ext?.uri).toBe(DINA_A2A_EXTENSION_URI);
    expect(ext).not.toHaveProperty('required');
    expect(ext?.params).toEqual({
      did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      skills: { 'eta_query@self': { paramsSchema: ETA_SCHEMA, schemaHash: 'a'.repeat(64) } },
      // How a DID-bound client signs (§5.1, M4), stated where clients read the contract.
      requestSigning: {
        headers: ['X-DID', 'X-Timestamp', 'X-Nonce', 'X-Signature'],
        canonical: 'dina-a2a-request:v1\n{NODE_DID}\n{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}',
        audience: 'NODE_DID is the did this card’s Dina extension names: a request signed for one node verifies at no other',
        signature: 'Ed25519, lower-case hex',
        timestamp: 'RFC 3339 UTC, within five minutes',
        nonce: '16 to 128 characters of [A-Za-z0-9_-], never reused',
        keys: 'Ed25519 keys under authentication; in a document with none (did:plc), its Ed25519 verification methods',
        binding: '/a2a/v1/did-binding',
      },
    });
  });

  it('carries a usable call in standard fields too', () => {
    expect(skill.inputModes).toEqual(['application/json']);
    expect(skill.examples).toHaveLength(1);
    const example = JSON.parse(skill.examples?.[0] as string) as unknown;
    const parsed = parseEnvelopeData(example);
    expect(parsed.ok).toBe(true);
    expect(example).toEqual({ skill: 'eta_query@self', params: { route: 'x', stop: '' } });
    expect(skill.description).toContain('Required params: route (string), stop (string).');
  });

  it('declares only the features built today', () => {
    expect(out.card.capabilities).toMatchObject({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    });
    expect(out.card.supportedInterfaces).toEqual([
      { url: 'https://a2a.example.org/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
  });
});

describe('the interfaces, in preference order', () => {
  it('lists REST after JSON-RPC when the node serves it', () => {
    const both = projectAgentCard({ ...input([listing()]), restInterfaceUrl: 'https://a2a.example.org/a2a/rest' });
    if (!both.ok) throw new Error(both.reason);
    expect(both.card.supportedInterfaces).toEqual([
      { url: 'https://a2a.example.org/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'https://a2a.example.org/a2a/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ]);
  });
});

/** `depth` arrays nested, each of exactly `items` items, around integers. */
function nest(items: number, depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'integer' };
  for (let i = 0; i < depth; i += 1) schema = { type: 'array', minItems: items, items: schema };
  return schema;
}

describe('sample values from a schema', () => {
  it.each([
    [{ const: 7 }, 7],
    [{ enum: ['a', 'b'] }, 'a'],
    [{ type: 'string', minLength: 3 }, 'xxx'],
    [{ type: 'integer', minimum: 1.5 }, 2],
    [{ type: 'number' }, 0],
    [{ type: 'boolean' }, false],
    [{ type: 'array', minItems: 2, items: { type: 'integer' } }, [0, 0]],
    [{ type: 'array' }, []],
    [{ type: ['null', 'string'] }, null],
    [{ type: 'string', minLength: SAMPLE_MAX_LENGTH }, 'x'.repeat(SAMPLE_MAX_LENGTH)],
    [{ type: 'string', enum: [5, 'five'] }, 'five'],
    [{ type: 'integer', enum: [1.5, 2] }, 2],
    // At the value budget: the array and its items are 256 values in all.
    [{ type: 'array', const: Array(SAMPLE_MAX_VALUES - 1).fill(0) }, Array(SAMPLE_MAX_VALUES - 1).fill(0)],
    // Within the value budget: 16 × 15 = 240 leaves, 256 values in all.
    [{ type: 'array', minItems: 15, items: { type: 'array', minItems: 16, items: { type: 'null' } } }, Array(15).fill(Array(16).fill(null))],
  ])('%p → %p', (schema, value) => expect(sampleFromSchema(schema)).toEqual(value));

  it.each([
    [{ type: 'string', pattern: '^a+$' }],
    [{ type: 'string', format: 'date' }],
    // Past the placeholder caps: no example, and no huge (or impossible) string built.
    [{ type: 'string', minLength: 1_073_741_824 }],
    [{ type: 'string', minLength: SAMPLE_MAX_LENGTH + 1 }],
    [{ type: 'array', minItems: SAMPLE_MAX_ITEMS + 1, items: { type: 'integer' } }],
    // A const or enum member is used only when it is of the schema's type.
    [{ type: 'string', const: 5 }],
    [{ type: 'string', enum: [5, 6] }],
    // Malformed bounds give no example, never a throw ('x'.repeat(-1) would).
    [{ type: 'string', minLength: -1 }],
    [{ type: 'string', minLength: 2.5 }],
    [{ type: 'array', minItems: -1, items: { type: 'integer' } }],
    // A sample that would be too large once written out: 16 nested arrays of 16.
    [nest(SAMPLE_MAX_ITEMS, 3)],
    // Deeper than the sampler walks.
    [nest(1, SAMPLE_MAX_DEPTH + 1)],
    // A const or enum member far past the value budget: no example, and no throw
    // (200,000 items spread into one call would overflow the stack).
    [{ type: 'array', const: Array(200_000).fill(0) }],
    [{ type: 'object', const: Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i])) }],
    [{ type: 'array', enum: [Array(200_000).fill(0)] }],
    [{ type: 'array', const: Array(SAMPLE_MAX_VALUES).fill(0) }],
    [{ type: 'integer', minimum: 5, maximum: 3 }],
    [{ type: 'object', required: ['d'], properties: { d: { type: 'string', format: 'email' } } }],
    [{}],
  ])('gives up on %p', (schema) => expect(sampleFromSchema(schema)).toBeUndefined());

  it('the validator invocation uses has the last word: an example it refuses is left off, the skill kept', () => {
    const seen: unknown[] = [];
    const refused = projectAgentCard({ ...input([listing()]), acceptsExample: (params) => (seen.push(params), false) });
    expect(seen.length).toBeGreaterThan(0);
    expect(refused.ok && refused.card.skills[0]).not.toHaveProperty('examples');
    const accepted = projectAgentCard({ ...input([listing()]), acceptsExample: () => true });
    expect(accepted.ok && accepted.card.skills[0]?.examples).toHaveLength(1);
  });

  it('a long const leaves only the example off: an example is at most SAMPLE_MAX_EXAMPLE_BYTES', () => {
    const big = cap({ paramsSchema: { type: 'object', required: ['n'], properties: { n: { type: 'string', const: 'c'.repeat(8_000) } } } });
    expect(skillShareFits('self', big)).toBe(true);
    const out = projectAgentCard(input([listing({ capabilities: [big] })]));
    expect(out.ok && out.card.skills[0]?.id).toBe('eta_query@self');
    expect(out.ok && out.card.skills[0]).not.toHaveProperty('examples');
    const fits = cap({ paramsSchema: { type: 'object', required: ['n'], properties: { n: { type: 'string', const: 'c'.repeat(1_000) } } } });
    const shown = projectAgentCard(input([listing({ capabilities: [fits] })]));
    const example = shown.ok ? shown.card.skills[0]?.examples?.[0] : undefined;
    expect(utf8Bytes(example ?? '').length).toBeGreaterThan(1_000);
    expect(utf8Bytes(example ?? '').length).toBeLessThanOrEqual(SAMPLE_MAX_EXAMPLE_BYTES);
  });

  it('a skill past its share of a card, or one no card could carry, is left off with its reason', () => {
    const sized = (n: number) =>
      cap({ paramsSchema: { type: 'object', required: ['n'], properties: { n: { type: 'string', const: 'c'.repeat(n) } } } });
    expect(exclusionReason(listing(), sized(A2A_LIMITS.maxSkillShareBytes))).toBe('skill_too_large');
    expect(exclusionReason(listing(), sized(A2A_LIMITS.maxSkillShareBytes / 2))).toBeNull();
    // The description counts: it is on the card.
    expect(skillShareFits('self', cap({ description: 'd'.repeat(A2A_LIMITS.maxSkillShareBytes) }))).toBe(false);
    // Past JCS's nesting bound, or a lone surrogate: no card could carry it.
    let deep: unknown = 0;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(skillShareFits('self', cap({ paramsSchema: { type: 'array', const: deep } as never }))).toBe(false);
    expect(skillShareFits('self', cap({ description: '\ud800' }))).toBe(false);
    const out = projectAgentCard(input([listing({ capabilities: [sized(A2A_LIMITS.maxSkillShareBytes)] }), listing({ rkey: 'other' })]));
    expect(out.ok && out.card.skills.map((sk) => sk.id)).toEqual(['eta_query@other']);
  });

  it('measures a skill in its largest form: the granted, full-envelope card cannot hold more than the share', () => {
    // A size that fits as measured fits every form; the extended card's grant form is the largest.
    let lo = 0;
    let hi = A2A_LIMITS.maxSkillShareBytes;
    const sized = (n: number) => cap({ description: 'd'.repeat(n) });
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (skillShareFits('self', sized(mid))) lo = mid;
      else hi = mid - 1;
    }
    const largest = sized(lo);
    const audience: CardAudience = { scope: [], grants: [{ grantId: 'g'.repeat(MAX_ID_LENGTH), rkey: 'self', capability: 'eta_query' }] };
    const extended = projectSkills([listing({ discoverability: 'unlisted', capabilities: [largest] })], audience);
    expect(extended).toHaveLength(1);
    const entry = extended[0];
    const share = canonicalize({
      skill: entry?.skill as never,
      contract: { paramsSchema: entry?.paramsSchema ?? {}, schemaHash: entry?.schemaHash ?? '', grantId: entry?.grantId ?? '' },
    });
    expect(utf8Bytes(share).length).toBeLessThanOrEqual(A2A_LIMITS.maxSkillShareBytes);
  });

  it('a skill id longer than a card allows is left off, with its reason; the rest of the card stands', () => {
    const at = (n: number) => 'r'.repeat(n - 'eta_query@'.length);
    const fits = listing({ rkey: at(MAX_ID_LENGTH) });
    const long = listing({ rkey: at(MAX_ID_LENGTH + 1) });
    expect(exclusionReason(fits, cap())).toBeNull();
    expect(exclusionReason(long, cap())).toBe('skill_id_too_long');
    const out = projectAgentCard(input([fits, long]));
    expect(out.ok && out.card.skills.map((sk) => sk.id.length)).toEqual([MAX_ID_LENGTH]);
    expect(out.ok && validateAgentCardShape(out.card)).toBeNull();
  });

  it('omits the example when no sample can be built, keeping the skill', () => {
    const out = projectAgentCard(
      input([
        listing({
          capabilities: [
            cap({
              paramsSchema: {
                type: 'object',
                required: ['d'],
                properties: { d: { type: 'string', format: 'date' } },
              },
            }),
          ],
        }),
      ]),
    );
    expect(out.ok && out.card.skills[0]).not.toHaveProperty('examples');
  });
});

describe('the extended card projects for one client (design §7.1, M3)', () => {
  const quote = cap({
    capability: 'price_check',
    canonical: 'price_check',
    displayName: 'Price check',
  });
  const listings = [
    listing({ rkey: 'self', capabilities: [cap(), quote] }),
    listing({
      rkey: 'clinic',
      discoverability: 'known_only',
      capabilities: [cap({ publicExposureAllowed: false })],
    }),
    listing({ rkey: 'hidden', discoverability: 'unlisted', capabilities: [cap()] }),
  ];
  const extended = (audience: CardAudience) => {
    const out = projectAgentCard({ ...input(listings), audience });
    if (!out.ok) throw new Error(out.reason);
    return out;
  };

  it('with no scope and no grants: every public skill, each example a full envelope', () => {
    const out = extended({ scope: [], grants: [] });
    expect(out.skills.map((s) => s.skill.id)).toEqual(['eta_query@self', 'price_check@self']);
    const example = parseEnvelopeData(JSON.parse(out.skills[0]?.skill.examples?.[0] ?? '{}'));
    expect(example).toEqual(expect.objectContaining({ ok: true }));
    expect(JSON.parse(out.skills[0]?.skill.examples?.[0] ?? '{}')).toEqual(
      expect.objectContaining({ schema_hash: 'a'.repeat(64) }),
    );
  });

  it('a scope narrows the public skills, by qualified id or canonical name', () => {
    expect(
      extended({ scope: ['price_check@self'], grants: [] }).skills.map((s) => s.skill.id),
    ).toEqual(['price_check@self']);
    expect(extended({ scope: ['eta_query'], grants: [] }).skills.map((s) => s.skill.id)).toEqual([
      'eta_query@self',
    ]);
  });

  it('a live grant adds its skill on a known_only or unlisted listing, sensitive or not, with its grant id', () => {
    const out = extended({
      scope: ['price_check'],
      grants: [
        { grantId: 'g-clinic', rkey: 'clinic', capability: 'eta_query' },
        { grantId: 'g-hidden', rkey: 'hidden', capability: 'eta_query' },
      ],
    });
    expect(out.skills.map((s) => [s.skill.id, s.grantId ?? null])).toEqual([
      ['eta_query@clinic', 'g-clinic'],
      ['eta_query@hidden', 'g-hidden'],
      ['price_check@self', null],
    ]);
    const clinic = out.skills.find((s) => s.skill.id === 'eta_query@clinic');
    expect(JSON.parse(clinic?.skill.examples?.[0] ?? '{}')).toEqual(
      expect.objectContaining({
        skill: 'eta_query@clinic',
        grant_id: 'g-clinic',
        schema_hash: 'a'.repeat(64),
      }),
    );
    const ext = out.card.capabilities.extensions?.[0]?.params as {
      skills: Record<string, { grantId?: string }>;
    };
    expect(ext.skills['eta_query@clinic']?.grantId).toBe('g-clinic');
    expect(ext.skills['price_check@self']?.grantId).toBeUndefined();
  });

  it('a grant on a public listing adds nothing: invocation applies the public rules and the scope there', () => {
    const out = extended({
      scope: ['price_check'],
      grants: [{ grantId: 'g1', rkey: 'self', capability: 'eta_query' }],
    });
    expect(out.skills.map((s) => s.skill.id)).toEqual(['price_check@self']);
  });

  it('a grant on a capability no executor can run, or a paused listing, adds nothing', () => {
    const paused = [
      listing({
        rkey: 'p',
        discoverability: 'known_only',
        status: 'paused',
        capabilities: [cap()],
      }),
    ];
    const noExec = [
      listing({
        rkey: 'n',
        discoverability: 'known_only',
        capabilities: [cap({ executor: null })],
      }),
    ];
    for (const ls of [paused, noExec]) {
      const out = projectAgentCard({
        ...input([listing(), ...ls]),
        audience: {
          scope: [],
          grants: [{ grantId: 'g', rkey: ls[0]?.rkey ?? '', capability: 'eta_query' }],
        },
      });
      expect(out.ok && out.skills.map((s) => s.skill.id)).toEqual(['eta_query@self']);
    }
  });

  it('two grants for one capability: the first by id is the one shown', () => {
    const out = extended({
      scope: [],
      grants: [
        { grantId: 'g-b', rkey: 'clinic', capability: 'eta_query' },
        { grantId: 'g-a', rkey: 'clinic', capability: 'eta_query' },
      ],
    });
    expect(out.skills.find((s) => s.skill.id === 'eta_query@clinic')?.grantId).toBe('g-a');
  });

  it('the public card is unchanged by the audience machinery: no grant ids, no schema hash in examples', () => {
    const out = projectAgentCard(input(listings));
    expect(out.ok && out.skills.every((s) => s.grantId === undefined)).toBe(true);
    if (out.ok)
      expect(JSON.parse(out.skills[0]?.skill.examples?.[0] ?? '{}').schema_hash).toBeUndefined();
  });
});
