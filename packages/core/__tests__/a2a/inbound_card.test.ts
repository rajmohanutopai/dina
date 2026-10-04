/**
 * Lane 2's public card (design §7.1, §7.6): projected from live listings with
 * the functions invocation uses, signed with the card key, and usable with
 * the Dina extension ignored.
 */

import {
  A2A_LIMITS,
  A2A_NAME_MAX_CODE_POINTS,
  A2A_REST_PATH,
  MAX_TEXT_CODE_POINTS,
  base64urlDecode,
  canonicalize,
  exclusionReason,
  parseInvocationEnvelope,
  parseSendMessageResult,
  skillShareFits,
  utf8Bytes,
  validateAgentCardShape,
  verifyAgentCardSignatures,
  type AgentCard,
  type JsonObject,
  type JsonValue,
} from '@dina/a2a';

import {
  A2A_JWKS_PATH,
  A2A_RPC_PATH,
  PrincipalBudgets,
  bindRunner,
  buildInboundCard,
  cardPublicJwk,
  createA2AClient,
  getA2ACardConfig,
  inboundProjectionListings,
  ingressSendMessage,
  installA2ACardConfig,
  parsePublicJwk,
  unbindRunner,
  verifyWithJwk,
  type A2ACardConfig,
  type InboundRuntime,
} from '../../src/a2a';
import { projectionCapability } from '../../src/a2a/inbound_card';
import { deriveP256SigningKey } from '../../src/crypto';
import { registerDevice, resetDeviceRegistry } from '../../src/devices/registry';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2AIngressRoutes } from '../../src/server/routes/a2a_ingress';
import { resetServiceConfigState, setServiceConfigDurable, validateServiceConfigForSave } from '../../src/service/service_config';
import { SQLiteServiceConfigRepository, setServiceConfigRepository } from '../../src/service/service_config_repository';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';

import { LaneWorld } from './outbound_fixture';

import type { ServiceConfig } from '@dina/protocol';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const ORIGIN = 'https://dina.example.org';
const SEED = new Uint8Array(32).map((_, i) => i + 1);
const CONFIG: A2ACardConfig = { key: { privateKey: deriveP256SigningKey(SEED, 0).privateKey, generation: 0 }, publicOrigin: ORIGIN };

const ETA_PARAMS = { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } };
const ETA_RESULT = { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } };
const PRICE_PARAMS = { type: 'object', required: ['item'], properties: { item: { type: 'string' } } };
const PRICE_RESULT = { type: 'object', properties: { price: { type: 'number' } } };

let world: LaneWorld;
let runnerDid: string;

function listing(over: Partial<ServiceConfig>): ServiceConfig {
  return {
    isDiscoverable: true,
    discoverability: 'public',
    status: 'active',
    name: 'Bus 42',
    description: 'Arrival times for route 42.',
    capabilities: {
      eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' },
      price_check: { responsePolicy: 'auto', instruction: 'Quote from the fare table.', category: 'commerce' },
    },
    capabilitySchemas: {
      eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-eta' },
      price_check: { params: PRICE_PARAMS, result: PRICE_RESULT, schemaHash: 'h-price' },
    },
    ...over,
  };
}

/** A save as the owner's route makes it: validated first. */
async function save(config: ServiceConfig, rkey = 'self'): Promise<void> {
  const verdict = validateServiceConfigForSave(config);
  if (!verdict.ok) throw new Error(`fixture listing refused: ${JSON.stringify(verdict)}`);
  await setServiceConfigDurable(config, rkey);
}

beforeEach(async () => {
  resetDeviceRegistry();
  resetServiceConfigState();
  // Set at boot, as on every node: a call's rounds name their listing under it.
  setNodeDID(NODE_DID);
  world = new LaneWorld();
  setServiceConfigRepository(new SQLiteServiceConfigRepository(world.store.db));
  runnerDid = registerDevice('Transit runner', 'z6MkCardRunner', 'agent', 'runner').did;
  bindRunner(world.store, { lane: 'transit', device_did: runnerDid }, world.clock);
  await save(listing({}));
});

afterEach(() => {
  installA2ACardConfig(null);
  clearPairingState();
  setServiceConfigRepository(null);
  resetServiceConfigState();
  resetDeviceRegistry();
  world.close();
});

async function card(): Promise<AgentCard> {
  const built = await buildInboundCard(world.store, { nodeDid: NODE_DID, config: CONFIG });
  if (!built.ok) throw new Error(built.reason);
  return built.card;
}

const skillIds = (c: AgentCard) => c.skills.map((s) => s.id).sort();

describe('projection: what a call can reach, and nothing else', () => {
  it('projects a bound lane and an instruction-only capability; validates as a v1.0 card', async () => {
    const c = await card();
    expect(skillIds(c)).toEqual(['eta_query@self', 'price_check@self']);
    expect(validateAgentCardShape(c)).toBeNull();
    expect(c.name).toBe('Bus 42');
    expect(c.description).toBe('Arrival times for route 42.');
    // JSON-RPC first, then REST (M4): the same operations, two ways in.
    expect(c.supportedInterfaces).toEqual([
      { url: `${ORIGIN}${A2A_RPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${ORIGIN}${A2A_REST_PATH}`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ]);
    // M3: streams, webhooks and the extended card are served.
    expect(c.capabilities).toEqual(expect.objectContaining({ streaming: true, pushNotifications: true, extendedAgentCard: true }));
    const ext = c.capabilities.extensions?.[0]?.params as { did: string; skills: Record<string, unknown> };
    expect(ext.did).toBe(NODE_DID);
  });

  it('drops a skill when its runner binding is revoked, and the version moves with it', async () => {
    const before = await card();
    unbindRunner(world.store, 'transit', world.clock);
    const after = await card();
    expect(skillIds(after)).toEqual(['price_check@self']);
    expect(after.version).not.toBe(before.version);
    expect((await card()).version).toBe(after.version);
  });

  it.each([
    ['an unlisted listing', { discoverability: 'unlisted' as const, isDiscoverable: false }],
    ['a known_only listing', { discoverability: 'known_only' as const, isDiscoverable: false }],
    ['a paused listing', { status: 'paused' as const }],
    // Never a valid row (Talk is known_only); written past the validator.
    ['a public Talk listing', { surface: 'talk' as const }],
  ])('leaves out %s entirely', async (name, over) => {
    if (name === 'a public Talk listing') await setServiceConfigDurable(listing(over), 'self');
    else await save(listing(over));
    const built = await buildInboundCard(world.store, { nodeDid: NODE_DID, config: CONFIG });
    expect(built).toEqual({ ok: false, reason: 'no_projectable_skills' });
  });

  // Cold audit C5-9: each entry carries a valid schema pair, so only its own rule can leave it out.
  describe('leaves out each kind of capability by its own rule, whatever a row says', () => {
    type Entry = ServiceConfig['capabilities'][string];
    const PAIR = { params: PRICE_PARAMS, result: PRICE_RESULT, schemaHash: 'h' };
    /** A listing of eta_query and `key`, written past the validator: the card must not trust the row. */
    async function writeWith(key: string, entry: Entry): Promise<void> {
      await setServiceConfigDurable(
        listing({
          capabilities: { eta_query: listing({}).capabilities.eta_query, [key]: entry },
          capabilitySchemas: { eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h' }, [key]: PAIR },
        }),
        'self',
      );
    }
    const projected = (key: string) => {
      const l = inboundProjectionListings(world.store).find((x) => x.rkey === 'self');
      const cap = l?.capabilities.find((c) => c.capability === key);
      if (l === undefined || cap === undefined) throw new Error('not classified');
      return { l, cap };
    };

    it.each([
      // [what, key, entry, the rule, the same capability with that rule met]
      ['a capability on an unbound lane', 'price_check', { mcpServer: 'nobody', mcpTool: 'x', responsePolicy: 'auto', category: 'transit' }, 'no_executor', { executor: 'mcp_server' }],
      ['a capability on the reserved lane', 'price_check', { mcpServer: 'dina.local', mcpTool: 'x', responsePolicy: 'auto', category: 'transit' }, 'no_executor', { executor: 'mcp_server' }],
      ['a non-public capability', 'appointment_status', { responsePolicy: 'review', instruction: 'x', category: 'appointments' }, 'not_public_exposable', { publicExposureAllowed: true }],
      ['a commerce capability', 'com.dinakernel.commerce.order_status', { responsePolicy: 'auto', instruction: 'x', category: 'commerce' }, 'commerce_capability', null],
    ] as const)('%s', async (_what, key, entry, rule, met) => {
      await writeWith(key, entry as Entry);
      expect(skillIds(await card())).toEqual(['eta_query@self']);
      const { l, cap } = projected(key);
      // It has its schema pair: the schema rule is not what leaves it out.
      expect(cap.paramsSchema).toBeDefined();
      expect(exclusionReason(l, cap)).toBe(rule);
      // Control: with that one rule met, nothing else stands in the way.
      if (met !== null) expect(exclusionReason(l, { ...cap, ...met })).toBeNull();
    });

    it('control: the unbound lane, once bound, puts the skill on the card', async () => {
      await writeWith('price_check', { mcpServer: 'nobody', mcpTool: 'x', responsePolicy: 'auto', category: 'transit' });
      expect(skillIds(await card())).toEqual(['eta_query@self']);
      bindRunner(world.store, { lane: 'nobody', device_did: runnerDid }, world.clock);
      expect(skillIds(await card())).toEqual(['eta_query@self', 'price_check@self']);
    });

    it('control: the commerce entry’s shape under a plain capability is projected', async () => {
      await writeWith('price_check', { responsePolicy: 'auto', instruction: 'x', category: 'commerce' });
      expect(skillIds(await card())).toEqual(['eta_query@self', 'price_check@self']);
    });

    it('and a capability with no schema pair, by that rule', async () => {
      await setServiceConfigDurable(listing({ capabilitySchemas: { eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h' } } }), 'self');
      expect(skillIds(await card())).toEqual(['eta_query@self']);
      const { l, cap } = projected('price_check');
      expect(exclusionReason(l, cap)).toBe('no_schema_pair');
    });
  });
});

describe('signature', () => {
  it('verifies under the key its jku serves, named by its thumbprint', async () => {
    const built = await buildInboundCard(world.store, { nodeDid: NODE_DID, config: CONFIG });
    if (!built.ok) throw new Error(built.reason);
    const [jwk] = built.jwks.keys;
    expect(jwk).toEqual(cardPublicJwk(CONFIG.key));
    expect(JSON.stringify(jwk)).not.toContain('"d"');
    const parsed = parsePublicJwk(jwk);
    if (parsed === null) throw new Error('jwk');
    const report = await verifyAgentCardSignatures(built.card as unknown as Record<string, unknown>, ({ header, signingInputs, signature }) => {
      expect(header).toEqual(expect.objectContaining({ alg: 'ES256', kid: jwk?.kid, jku: `${ORIGIN}${A2A_JWKS_PATH}` }));
      return signingInputs.some((input) => verifyWithJwk(parsed, header.alg, input, signature));
    });
    expect(report.state).toBe('verified');
  });

  it('a change to the card after signing fails verification', async () => {
    const c = { ...(await card()), name: 'Someone else' };
    const jwk = parsePublicJwk(cardPublicJwk(CONFIG.key));
    if (jwk === null) throw new Error('jwk');
    const report = await verifyAgentCardSignatures(c as unknown as Record<string, unknown>, ({ header, signingInputs, signature }) =>
      signingInputs.some((input) => verifyWithJwk(jwk, header.alg, input, signature)),
    );
    expect(report.state).toBe('invalid');
  });

  it('the key is the frozen ES256 card key of the seed', () => {
    const jwk = cardPublicJwk(CONFIG.key);
    expect(base64urlDecode(jwk.x as string)?.length).toBe(32);
    expect(cardPublicJwk({ privateKey: deriveP256SigningKey(SEED, 1).privateKey, generation: 1 }).kid).not.toBe(jwk.kid);
  });
});

describe('usable with the extension ignored (§7.6)', () => {
  it('every skill’s standard-field example is a call Core accepts', async () => {
    const c = await card();
    const created = createA2AClient(world.store, { display_name: 'Plain client' }, world.clock);
    if (!created.ok) throw new Error(created.reason);
    const rt: InboundRuntime = { a2a: world.runtime, grants: new SQLiteServiceGrantRepository(world.store.db), budgets: new PrincipalBudgets() };
    let n = 0;
    for (const skill of c.skills) {
      const example = skill.examples?.[0];
      if (example === undefined) throw new Error(`${skill.id} carries no example`);
      const data = JSON.parse(example) as JsonObject;
      expect(parseInvocationEnvelope([{ data }]).ok).toBe(true);
      n += 1;
      const answer = ingressSendMessage(rt, {
        request: {
          method: 'POST',
          path: A2A_RPC_PATH,
          query: '',
          version: '1.0',
          body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'SendMessage', params: { message: { messageId: `ex-${n}`, role: 'ROLE_USER', parts: [{ data }] } } }),
        },
        client_auth: { authorization: `Bearer ${created.token}` },
      });
      // A2A v1.0 answers SendMessage with `{task}`: Dina's own Lane 1 parser must read it.
      const parsed = parseSendMessageResult((answer.body as { result: unknown }).result);
      if (!('kind' in parsed) || parsed.kind !== 'task') throw new Error(`${skill.id}: ${JSON.stringify(parsed)}`);
      expect([skill.id, (parsed.task.status as { state: string }).state]).toEqual([skill.id, 'TASK_STATE_SUBMITTED']);
    }
    expect(n).toBe(2);
  });
});

describe('one listing can never break the card', () => {
  it('a schema asking for a huge string drops only that example; the rest of the card is built', async () => {
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 1_073_741_824 } } },
            result: ETA_RESULT,
            schemaHash: 'h-big',
          },
        },
      }),
      'bulk',
    );
    const c = await card();
    expect(skillIds(c)).toEqual(['eta_query@bulk', 'eta_query@self', 'price_check@self'].sort());
    expect(c.skills.find((s) => s.id === 'eta_query@bulk')).not.toHaveProperty('examples');
    expect(c.skills.find((s) => s.id === 'eta_query@self')?.examples).toHaveLength(1);
  });

  it('a saveable listing whose skill is too large for its share of a card leaves only that skill off; the card is built', async () => {
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['n'], properties: { n: { type: 'array', const: Array(200_000).fill(0) } } },
            result: ETA_RESULT,
            schemaHash: 'h-big-const',
          },
        },
      }),
      'bulk',
    );
    const c = await card();
    expect(skillIds(c)).toEqual(['eta_query@self', 'price_check@self']);
    expect(c.skills.find((s) => s.id === 'eta_query@self')?.examples).toHaveLength(1);
  });

  it('seven skills each at the largest share that fits always build a signed card; enough of them fill it', async () => {
    // Every listing carries a name and description far past their bounds: whichever names the card, it costs at most its cap.
    const etaOnly = (rkey: string, n: number): ServiceConfig =>
      listing({
        name: '😀'.repeat(5_000),
        description: '😀'.repeat(20_000),
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['n'], properties: { n: { type: 'string', const: 'c'.repeat(n) } } },
            result: ETA_RESULT,
            schemaHash: `h-${rkey}`,
          },
        },
      });
    // The largest const that still fits one skill's share, found against the rule itself.
    const fits = (n: number) => skillShareFits('r1', projectionCapability(world.store, etaOnly('r1', n), 'eta_query'));
    let lo = 0;
    let hi = A2A_LIMITS.maxSkillShareBytes;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    expect(lo).toBeGreaterThan(A2A_LIMITS.maxSkillShareBytes - 2_048);
    await save(listing({ discoverability: 'unlisted' }), 'self'); // only the large skills are public
    for (let i = 1; i <= 7; i += 1) await save(etaOnly(`r${i}`, lo), `r${i}`);
    const built = await buildInboundCard(world.store, { nodeDid: NODE_DID, config: CONFIG });
    expect(built.ok && built.card.skills).toHaveLength(7);
    expect(built.ok && [...built.card.description]).toHaveLength(MAX_TEXT_CODE_POINTS);
    expect(built.ok && utf8Bytes(canonicalize(built.card as unknown as JsonValue)).length).toBeLessThanOrEqual(A2A_LIMITS.maxCardBytes);
    // The share is measured in its largest form, so seven is the floor; enough skills at the bound fill the card, and the owner is told.
    for (let i = 8; i <= 9; i += 1) await save(etaOnly(`r${i}`, lo), `r${i}`);
    expect(await buildInboundCard(world.store, { nodeDid: NODE_DID, config: CONFIG })).toEqual({ ok: false, reason: 'card_too_large' });
  });

  it('a skill whose const is past the sample budget keeps its place, without an example', async () => {
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['n'], properties: { n: { type: 'array', const: Array(1_000).fill(0) } } },
            result: ETA_RESULT,
            schemaHash: 'h-mid-const',
          },
        },
      }),
      'mid',
    );
    const skill = (await card()).skills.find((s) => s.id === 'eta_query@mid');
    expect(skill).toBeDefined();
    expect(skill).not.toHaveProperty('examples');
  });

  it('an enum member of the wrong type never becomes an example Core would refuse', async () => {
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['n'], properties: { n: { type: 'string', enum: [5, 'five'] } } },
            result: ETA_RESULT,
            schemaHash: 'h-enum',
          },
        },
      }),
      'enum',
    );
    const example = (await card()).skills.find((s) => s.id === 'eta_query@enum')?.examples?.[0];
    expect(JSON.parse(example ?? '{}')).toEqual({ skill: 'eta_query@enum', params: { n: 'five' } });
  });

  it('an example Core’s validator would refuse is left off, though the sampler proposed it', async () => {
    // The sampler takes the first enum member of the type; it does not weigh maxLength. Core does.
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
        capabilitySchemas: {
          eta_query: {
            params: { type: 'object', required: ['n'], properties: { n: { type: 'string', enum: ['toolong', 'ok'], maxLength: 2 } } },
            result: ETA_RESULT,
            schemaHash: 'h-enum-len',
          },
        },
      }),
      'len',
    );
    const skill = (await card()).skills.find((s) => s.id === 'eta_query@len');
    expect(skill).toBeDefined();
    expect(skill).not.toHaveProperty('examples');
  });

  it('the card’s name and description are bounded as a remote’s words are: one long listing never refuses the card', async () => {
    await save(listing({ name: `Bus\u202e ${'n'.repeat(500)}`, description: 'x'.repeat(140 * 1024) }), 'self');
    const c = await card();
    expect([...c.name]).toHaveLength(A2A_NAME_MAX_CODE_POINTS);
    expect(c.name.startsWith('Bus n')).toBe(true);
    expect([...c.description]).toHaveLength(MAX_TEXT_CODE_POINTS);
    expect(c.description.endsWith('…')).toBe(true);
    expect(skillIds(c)).toEqual(['eta_query@self', 'price_check@self']);
  });

  it('a listing name of nothing visible gives the card a plain name, never an empty one', async () => {
    await save(listing({ name: '\u200b\u202e\u2066' }), 'self');
    expect((await card()).name).toBe('A Dina node');
  });
});

describe('configuration and the gateway route', () => {
  it('refuses an origin with a path, credentials, or plain http off loopback', () => {
    for (const bad of ['https://x.example/a2a', 'https://u:p@x.example', 'http://x.example', 'not a url', 'https://x.example/?q=1']) {
      expect(() => installA2ACardConfig({ ...CONFIG, publicOrigin: bad })).toThrow();
    }
    installA2ACardConfig({ ...CONFIG, publicOrigin: 'http://127.0.0.1:8400' });
    expect(getA2ACardConfig()?.publicOrigin).toBe('http://127.0.0.1:8400');
  });

  const router = new CoreRouter();
  registerA2AIngressRoutes(router);
  const get = (callerType: string) =>
    router.handle({
      method: 'GET',
      path: '/v1/a2a/card',
      query: {},
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType,
      callerDID: 'did:key:gateway',
    } as CoreRequest);

  it('serves the gateway only, and says when the card is not configured', async () => {
    expect((await get('gateway')).status).toBe(503);
    installA2ACardConfig(CONFIG);
    expect((await get('brain')).status).toBe(403);
    const ok = await get('gateway');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body as object).sort()).toEqual(['card', 'jwks']);
  });
});
