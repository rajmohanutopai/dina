/**
 * Area A of the A2A test plan, checked end to end through Core: the card
 * cap on the card Dina builds, task ids that look like path steps, the card
 * key verifier Core runs on a remote card, and the card key's path rules on
 * every curve.
 */

import { p256 } from '@noble/curves/nist.js';

import {
  A2A_LIMITS,
  A2A_METHODS,
  A2A_DISPATCH_TABLE,
  canonicalize,
  cardSigningForms,
  ingressPathFor,
  parseProtectedHeader,
  signAgentCard,
  verifyAgentCardSignatures,
  type JsonValue,
} from '@dina/a2a';

import {
  A2A_JWKS_PATH,
  buildInboundCard,
  cardPublicJwk,
  createJkuVerifier,
  type A2ACardConfig,
  type KeyResolutionNote,
} from '../../src/a2a';
import { derivePath, derivePathP256, derivePathSecp256k1, deriveP256SigningKey } from '../../src/crypto';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2AIngressRoutes } from '../../src/server/routes/a2a_ingress';

import { ETA_RESULT, InboundWorld, listing, resultOf, save, sentTask } from './inbound_fixture';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const SEED = new Uint8Array(32).map((_, i) => i + 1);
const CARD: A2ACardConfig = {
  key: { privateKey: deriveP256SigningKey(SEED, 0).privateKey, generation: 0 },
  publicOrigin: 'https://dina.example.org',
};

/**
 * A bus listing whose one skill has a large call contract: thirty optional
 * params, each with a 380-character description (the schema audit allows
 * 400). About 13 KB, inside one skill's share of a card.
 */
const largeListing = () =>
  listing({
    capabilitySchemas: {
      eta_query: {
        params: {
          type: 'object',
          required: ['route_id'],
          properties: {
            route_id: { type: 'string', minLength: 1 },
            ...Object.fromEntries(
              Array.from({ length: 30 }, (_, i) => [`note_${i}`, { type: 'string', description: `${i}`.padEnd(380, 'd') }]),
            ),
          },
        },
        result: ETA_RESULT,
        schemaHash: 'h-eta',
      },
    },
  });

describe('the card Dina builds never passes the card cap (design §6.6, §8.3)', () => {
  let iw: InboundWorld;
  beforeEach(async () => {
    iw = await InboundWorld.create();
  });
  afterEach(() => iw.close());

  // Plan A13
  it('builds a card of many large skills while it fits in 128 KB of canonical bytes', async () => {
    for (let i = 0; i < 4; i += 1) await save(largeListing(), `large-${i}`);
    const built = await buildInboundCard(iw.world.store, { nodeDid: NODE_DID, config: CARD });
    if (!built.ok) throw new Error(built.reason);
    expect(built.card.skills.filter((s) => s.id.startsWith('eta_query@large-'))).toHaveLength(4);
    const size = new TextEncoder().encode(canonicalize(built.card as unknown as JsonValue)).length;
    expect(size).toBeGreaterThan(48 * 1024);
    expect(size).toBeLessThanOrEqual(A2A_LIMITS.maxCardBytes);
  });

  // Plan A13
  it('refuses as card_too_large when listings that each fit their share pass the cap together', async () => {
    for (let i = 0; i < 12; i += 1) await save(largeListing(), `large-${i}`);
    expect(await buildInboundCard(iw.world.store, { nodeDid: NODE_DID, config: CARD })).toEqual({ ok: false, reason: 'card_too_large' });
  });
});

describe('a task id of . or .. reaches no other task or operation (design §4.3, §5.1)', () => {
  let iw: InboundWorld;
  const router = new CoreRouter();
  registerA2AIngressRoutes(router);
  const post = (path: string, body: unknown) =>
    router.handle({
      method: 'POST',
      path,
      query: {},
      headers: {},
      body,
      rawBody: new TextEncoder().encode(JSON.stringify(body)),
      params: {},
      trustedInProcess: true,
      callerType: 'gateway',
      callerDID: 'did:key:z6MkGateway',
    } as unknown as CoreRequest);

  beforeEach(async () => {
    iw = await InboundWorld.create();
  });
  afterEach(() => iw.close());

  /** The params of a call that names `id` in every route slot it has. */
  const paramsNaming = (method: (typeof A2A_METHODS)[number], id: string, realTask: string): Record<string, unknown> => {
    const ids = A2A_DISPATCH_TABLE[method].ids;
    const params: Record<string, unknown> = {};
    if (ids.extId === 'params.id') params.id = id;
    if (ids.extId === 'params.taskId') params.taskId = id;
    // With '.', a push-config call names the real task and a config called '.'; with '..', both ids are '..'.
    if (ids.configId === 'params.id') {
      params.taskId = id === '.' ? realTask : id;
      params.id = id;
    }
    if (method === 'CreateTaskPushNotificationConfig') params.url = 'https://hooks.example.org/a2a';
    return params;
  };

  const routed = A2A_METHODS.filter((m) => Object.keys(A2A_DISPATCH_TABLE[m].ids).length > 0);

  /** The results of GetTask and of the config list for `task`, as the gateway would ask for them. */
  const lookAt = async (task: string) => ({
    task: resultOf(await post(A2A_DISPATCH_TABLE.GetTask.path.replace(':extId', encodeURIComponent(task)), iw.request('GetTask', { id: task }))),
    configs: resultOf(
      await post(
        A2A_DISPATCH_TABLE.ListTaskPushNotificationConfigs.path.replace(':extId', encodeURIComponent(task)),
        iw.request('ListTaskPushNotificationConfigs', { taskId: task }),
      ),
    ),
  });

  // Plan A162
  it.each(routed.flatMap((m) => [[m, '.'] as const, [m, '..'] as const]))(
    '%s with id %p: neither the path as sent, nor its %%2e spelling, nor the path an HTTP client folds reaches another task or config',
    async (method, id) => {
      const real = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
      const made = await post(
        A2A_DISPATCH_TABLE.CreateTaskPushNotificationConfig.path.replace(':extId', encodeURIComponent(real)),
        iw.request('CreateTaskPushNotificationConfig', { taskId: real, url: 'https://hooks.example.org/real' }),
      );
      const configId = (made.body as { result: { id: string } }).result.id;
      const before = await lookAt(real);
      expect(JSON.stringify(before.configs)).toContain(configId);

      const envelope = iw.request(method, paramsNaming(method, id, real));
      const parsed = JSON.parse(envelope.request.body) as { id: number; params: Record<string, JsonValue> };
      // The shared builder forwards no dot-segment id at all (the gateway answers task not found).
      expect(ingressPathFor({ id: parsed.id, method, params: parsed.params as never })).toEqual({ ok: false, reason: 'id_unroutable' });

      // Core holds anyway when a gateway forwards the call: the template filled by hand from the signed params.
      const route = A2A_DISPATCH_TABLE[method];
      const fill = (spell: (v: string) => string): string =>
        Object.entries(route.ids).reduce(
          (path, [slot, where]) => path.replace(`:${slot}`, spell(String(where === 'params.id' ? parsed.params.id : parsed.params.taskId))),
          route.path,
        );
      const asSent = fill((v) => v);
      expect(asSent).toContain(`/${id}/`);
      const percent = fill((v) => (v === id ? v.replace(/\./g, '%2e') : v));
      const folded = new URL(asSent, 'http://core.internal').pathname;
      expect(folded).not.toContain(`/${id}/`);
      // Sent as is, or with its dots spelled %2e, the path binds the literal id, which no task or config has:
      // task not found, or for a delete of config '.', the idempotent empty answer (A2A §3.1.10).
      const want = method === 'DeleteTaskPushNotificationConfig' && id === '.' ? { result: {} } : { error: -32001 };
      for (const path of [asSent, percent]) {
        const body = (await post(path, envelope)).body as { result?: unknown; error?: { code: number } };
        const got = body.error === undefined ? { result: body.result } : { error: body.error.code };
        expect([path, got]).toEqual([path, want]);
        expect([path, JSON.stringify(body).includes(configId)]).toEqual([path, false]);
      }
      // Folded, it names no route (today), or a route that refuses a call signed for another operation or id.
      const text = JSON.stringify((await post(folded, envelope)).body);
      expect([folded, text]).toEqual([folded, expect.stringMatching(/no route|operation_mismatch|id_mismatch/)]);
      expect([folded, text.includes('"result"'), text.includes(configId)]).toEqual([folded, false, false]);
      // The real task and its config are as they were.
      expect(await lookAt(real)).toEqual(before);
    },
  );

  // Plan A162
  it('refuses a dot-step call a gateway sends to a real task’s route: the route must name the id the client signed', async () => {
    const real = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const before = await lookAt(real);
    for (const method of ['GetTask', 'CancelTask', 'SubscribeToTask'] as const) {
      const answer = await post(A2A_DISPATCH_TABLE[method].path.replace(':extId', encodeURIComponent(real)), iw.request(method, { id: '..' }));
      const text = JSON.stringify(answer.body);
      expect([method, text]).toEqual([method, expect.stringContaining('id_mismatch')]);
      expect(text).not.toContain('"result"');
    }
    // The real task and its configs are as they were: no call above reached it.
    expect(await lookAt(real)).toEqual(before);
  });
});

describe('Core’s card key verifier checks the key the kid names, and only that key (design §6.1, spec §8.4.3)', () => {
  let iw: InboundWorld;
  beforeEach(async () => {
    iw = await InboundWorld.create();
  });
  afterEach(() => iw.close());

  /** The card Core signs, with its content, its one signature's header, and the key set it serves. */
  const signedCard = async () => {
    const built = await buildInboundCard(iw.world.store, { nodeDid: NODE_DID, config: CARD });
    if (!built.ok) throw new Error(built.reason);
    const { signatures, ...content } = built.card as unknown as Record<string, unknown> & { signatures: { protected: string }[] };
    const genuine = signatures[0];
    const header = genuine === undefined ? null : parseProtectedHeader(genuine.protected);
    if (genuine === undefined || header === null || header.jku === undefined) throw new Error('expected a signature with a jku');
    return { content, genuine, kid: header.kid, jku: header.jku, keys: built.jwks.keys as unknown as JsonValue[] };
  };

  /** The production verifier over a key set served from memory, with the notes it keeps. */
  const verifierOver = (keys: JsonValue[]) => {
    const notes: KeyResolutionNote[] = [];
    const fetched: string[] = [];
    const verify = createJkuVerifier(notes, async (url) => {
      fetched.push(url);
      return { ok: true, keys };
    });
    return { verify, notes, fetched };
  };

  /** Another P-256 key: the card key of another generation, as a stale or stolen signer would hold. */
  const otherKey = deriveP256SigningKey(SEED, 7).privateKey;

  // Plan A89
  it('verifies the card Core signs, naming the signer by its key thumbprint', async () => {
    const card = await signedCard();
    expect(card.kid).toBe(cardPublicJwk(CARD.key).kid);
    const v = verifierOver(card.keys);
    expect(await verifyAgentCardSignatures({ ...card.content, signatures: [card.genuine] }, v.verify)).toEqual({
      state: 'verified',
      verifiedKids: [card.kid],
      verifiedSigners: [`jwk:${card.kid}`],
    });
    expect(v.notes).toEqual([{ kid: card.kid, jku: card.jku, outcome: 'verified' }]);
    expect(v.fetched).toEqual([card.jku]);
  });

  // Cold audit C3-1: the reference SDK signs and verifies another form of the card
  it('signs its card over each form; a signature over the SDK’s form alone verifies, with one note for it', async () => {
    const built = await buildInboundCard(iw.world.store, { nodeDid: NODE_DID, config: CARD });
    if (!built.ok) throw new Error(built.reason);
    const { signatures, ...content } = built.card as unknown as Record<string, unknown> & { signatures: unknown[] };
    // Every bearer card carries a scope-less requirement, which the SDK's form drops: the forms differ.
    expect(cardSigningForms(content)).toEqual(['spec', 'a2a_sdk']);
    expect(signatures).toHaveLength(2);
    const kid = cardPublicJwk(CARD.key).kid as string;
    const v = verifierOver(built.jwks.keys as unknown as JsonValue[]);
    expect(await verifyAgentCardSignatures({ ...content, signatures: [signatures[1]] }, v.verify)).toEqual({
      state: 'verified',
      verifiedKids: [kid],
      verifiedSigners: [`jwk:${kid}`],
    });
    // One signature, one note: the form it does not cover is no failure of it.
    expect(v.notes).toEqual([{ kid, jku: `https://dina.example.org${A2A_JWKS_PATH}`, outcome: 'verified' }]);
  });

  // Plan A89, design §6.6: the signer is the key itself (its thumbprint), whatever kid the set serves it under
  it('names a signer by its key’s thumbprint even when the set serves the key under another kid', async () => {
    const card = await signedCard();
    const other = cardPublicJwk({ privateKey: otherKey, generation: 7 });
    const renamed = { ...other, kid: 'k-7' } as unknown as JsonValue;
    const sig = await signAgentCard(card.content, { alg: 'ES256', kid: 'k-7', jku: card.jku }, (input) => p256.sign(input, otherKey));
    const v = verifierOver([...card.keys, renamed]);
    expect(await verifyAgentCardSignatures({ ...card.content, signatures: [sig] }, v.verify)).toEqual({
      state: 'verified',
      verifiedKids: ['k-7'],
      verifiedSigners: [`jwk:${other.kid as string}`],
    });
    expect(other.kid).not.toBe('k-7');
  });

  // Plan A89
  it('fails a signature made by another key under the kid and jku of the card key', async () => {
    const card = await signedCard();
    const forged = await signAgentCard(card.content, { alg: 'ES256', kid: card.kid, jku: card.jku }, (input) => p256.sign(input, otherKey));
    const v = verifierOver(card.keys);
    expect(await verifyAgentCardSignatures({ ...card.content, signatures: [forged] }, v.verify)).toEqual({
      state: 'invalid',
      verifiedKids: [],
      verifiedSigners: [],
    });
    expect(v.notes).toEqual([{ kid: card.kid, jku: card.jku, outcome: 'bad_signature' }]);
  });

  // Plan A89
  it('does not try a key the set holds under another kid: the signer’s own key in the set does not save a signature under the card key’s kid', async () => {
    const card = await signedCard();
    const other = cardPublicJwk({ privateKey: otherKey, generation: 7 });
    expect(other.kid).not.toBe(card.kid);
    const keys = [...card.keys, other as unknown as JsonValue];
    const forged = await signAgentCard(card.content, { alg: 'ES256', kid: card.kid, jku: card.jku }, (input) => p256.sign(input, otherKey));
    const v = verifierOver(keys);
    expect((await verifyAgentCardSignatures({ ...card.content, signatures: [forged] }, v.verify)).state).toBe('invalid');
    expect(v.notes).toEqual([{ kid: card.kid, jku: card.jku, outcome: 'bad_signature' }]);
    // Under its own kid, the same key verifies: the set is read, and the kid picks the key.
    const own = await signAgentCard(card.content, { alg: 'ES256', kid: other.kid as string, jku: card.jku }, (input) => p256.sign(input, otherKey));
    const w = verifierOver(keys);
    expect(await verifyAgentCardSignatures({ ...card.content, signatures: [own] }, w.verify)).toEqual({
      state: 'verified',
      verifiedKids: [other.kid],
      verifiedSigners: [`jwk:${other.kid as string}`],
    });
  });
});

describe('card-key paths take canonical indices on every curve (plan D4, notes M0)', () => {
  const seed = Uint8Array.from(Buffer.from('b0a1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f', 'hex'));

  // Plan X-2
  it.each(["m/9999'/5'/01'", "m/9999'/5'/1.5'", "m/9999'/5'/2147483648'", "m/9999'/5'/+1'", "m/9999'/5'/'", "m/9999'/5'/1e3'", "m/9999'/5'/ 1'"])(
    'refuses the index in %s on the Ed25519, secp256k1 and P-256 trees alike',
    (path) => {
      expect(() => derivePath(seed, path)).toThrow(/invalid index/);
      expect(() => derivePathSecp256k1(seed, path)).toThrow(/invalid index/);
      expect(() => derivePathP256(seed, path)).toThrow(/invalid index/);
    },
  );

  // Plan X-2
  it('derives the card key at its generation and no other: the same path on another curve is another key', () => {
    const card = deriveP256SigningKey(seed, 2);
    expect(card).toEqual(derivePathP256(seed, "m/9999'/5'/2'"));
    expect(Buffer.from(card.privateKey).toString('hex')).not.toBe(Buffer.from(derivePathSecp256k1(seed, "m/9999'/5'/2'").privateKey).toString('hex'));
    expect(Buffer.from(card.privateKey).toString('hex')).not.toBe(Buffer.from(deriveP256SigningKey(seed, 3).privateKey).toString('hex'));
  });
});
