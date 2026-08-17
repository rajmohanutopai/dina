/**
 * §3's Hop-1 gate: raw image bytes cannot reach a remote provider without a
 * live, matching, single-use authorization.
 *
 * The named fail-closed set — broker bypass, hash substitution,
 * authorization replay, wrong provider, mutation after authorization —
 * each appears here, and each asserts TWO things: the refusal, and that
 * the broker was never handed bytes. A gate that refuses after
 * transmitting has not gated anything.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  extractRowsThroughGate,
  IMAGE_EGRESS_AUTHORIZATION_TTL_MS,
  InMemoryImageEgressAuthorizationRepository,
  installImageEgressBroker,
  SQLiteImageEgressAuthorizationRepository,
  type CommerceImageReader,
  type ImageEgressAuthorization,
  type ImageEgressAuthorizationRepository,
  type ImageEgressBroker,
} from '../../src/commerce/image_egress';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = 1_800_000_000_000;

const PAGE_1 = new TextEncoder().encode('page-one-stripped-bytes');
const PAGE_2 = new TextEncoder().encode('page-two-stripped-bytes');
const hashOf = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

function makeAuthorization(
  overrides: Partial<ImageEgressAuthorization> = {},
): ImageEgressAuthorization {
  return {
    authorizationId: 'egr_test1',
    purpose: 'catalog_extraction',
    provider: 'openai',
    contentHashes: [hashOf(PAGE_1), hashOf(PAGE_2)],
    maxBytes: 8 * 1024 * 1024,
    createdAtMs: T0,
    expiresAtMs: T0 + IMAGE_EGRESS_AUTHORIZATION_TTL_MS,
    consumedAtMs: null,
    ...overrides,
  };
}

/** A broker that records every invocation — the transmission witness. */
function makeBroker(provider = 'openai'): {
  broker: ImageEgressBroker;
  invocations: { pages: readonly Uint8Array[] }[];
} {
  const invocations: { pages: readonly Uint8Array[] }[] = [];
  return {
    invocations,
    broker: {
      provider,
      extractRows: (args) => {
        invocations.push({ pages: args.pages });
        return Promise.resolve({
          rows: [
            {
              page_index: 0,
              cells: { sku: 'CM-CHAIR-1', name: 'Oak dining chair', list_price_minor_units: '1800000' },
            },
          ],
          model: 'stub-vision',
        });
      },
    },
  };
}

const images: CommerceImageReader = (artifactId) => {
  if (artifactId === 'img-1') return PAGE_1;
  if (artifactId === 'img-2') return PAGE_2;
  return null;
};

afterEach(() => {
  installImageEgressBroker(null);
});

function gateArgs(repo: ImageEgressAuthorizationRepository) {
  return {
    authorizations: repo,
    readImage: images,
    authorizationId: 'egr_test1',
    artifactIds: ['img-1', 'img-2'],
    nowMs: T0 + 1000,
  };
}

describe('the happy path, to prove the refusals below are not vacuous', () => {
  it('transmits once and returns rows only', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization());
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);

    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: true, schemaId: 'catalog-rows-1', model: 'stub-vision' });
    expect(invocations.length).toBe(1);
    // The authorization is spent.
    expect(repo.get('egr_test1')?.consumedAtMs).not.toBeNull();
  });
});

describe('BROKER BYPASS: no gate, no bytes', () => {
  it('refuses with no broker installed', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization());
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('no_egress_broker') });
  });

  it('refuses with no authorization, broker untouched', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: 'unknown_authorization' });
    expect(invocations.length).toBe(0);
  });
});

describe('HASH SUBSTITUTION and MUTATION AFTER AUTHORIZATION', () => {
  it('refuses bytes whose hash the authorization does not name', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    // The authorization pinned different bytes than the store now returns —
    // one write to the artifact between mint and egress is all it takes.
    repo.put(makeAuthorization({ contentHashes: [hashOf(PAGE_1), hashOf(new Uint8Array([1]))] }));
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);

    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('content_hash_mismatch'),
    });
    // NOTHING was transmitted, and the authorization was not spent on a
    // refusal the seller will want to retry after re-capturing.
    expect(invocations.length).toBe(0);
    expect(repo.get('egr_test1')?.consumedAtMs).toBeNull();
  });

  it('refuses a page count that disagrees with the authorization', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization({ contentHashes: [hashOf(PAGE_1)] }));
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: 'page_count_mismatch' });
    expect(invocations.length).toBe(0);
  });
});

describe('AUTHORIZATION REPLAY: single use means single use', () => {
  it('the second extraction refuses and does not transmit', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization());
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);

    const first = await extractRowsThroughGate(gateArgs(repo));
    expect(first.ok).toBe(true);
    const second = await extractRowsThroughGate(gateArgs(repo));
    expect(second).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('authorization_consumed'),
    });
    expect(invocations.length).toBe(1);
  });

  it('a provider FAILURE still spends the authorization', async () => {
    // "Maybe transmitted" is exactly the case a replay must not retransmit.
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization());
    installImageEgressBroker({
      provider: 'openai',
      extractRows: () => Promise.reject(new Error('socket dropped mid-request')),
    });
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('provider_failed') });
    expect(repo.get('egr_test1')?.consumedAtMs).not.toBeNull();
  });
});

describe('WRONG PROVIDER: consent names one counterparty', () => {
  it('refuses a broker for a provider the authorization does not name', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization({ provider: 'anthropic' }));
    const { broker, invocations } = makeBroker('openai');
    installImageEgressBroker(broker);
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining('wrong_provider') });
    expect(invocations.length).toBe(0);
  });
});

describe('expiry and size', () => {
  it('refuses an expired authorization', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization());
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);
    const result = await extractRowsThroughGate({
      ...gateArgs(repo),
      nowMs: T0 + IMAGE_EGRESS_AUTHORIZATION_TTL_MS,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'authorization_expired' });
    expect(invocations.length).toBe(0);
  });

  it('refuses an authorization stamped in the future (clock moved backwards)', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization({ createdAtMs: T0 + 60_000 }));
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: 'authorization_expired' });
    expect(invocations.length).toBe(0);
  });

  it('refuses bytes over the authorized ceiling', async () => {
    const repo = new InMemoryImageEgressAuthorizationRepository();
    repo.put(makeAuthorization({ maxBytes: PAGE_1.byteLength }));
    const { broker, invocations } = makeBroker();
    installImageEgressBroker(broker);
    const result = await extractRowsThroughGate(gateArgs(repo));
    expect(result).toMatchObject({ ok: false, refusal: 'over_authorized_size' });
    expect(invocations.length).toBe(0);
  });
});

describe('the SQLite repository agrees with the double', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'image-egress-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: bytesToHex(randomBytes(32)),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });
  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips, consumes exactly once, and fails closed on corruption', () => {
    const repo = new SQLiteImageEgressAuthorizationRepository(adapter);
    repo.put(makeAuthorization());
    expect(repo.get('egr_test1')).toEqual(makeAuthorization());

    expect(repo.consume('egr_test1', T0 + 500)).toBe(true);
    expect(repo.consume('egr_test1', T0 + 600)).toBe(false);
    expect(repo.get('egr_test1')?.consumedAtMs).toBe(T0 + 500);

    // A row whose hash list was edited after writing reads as absent.
    adapter.run(
      `UPDATE commerce_image_egress_authorizations SET content_hashes_json = ?
        WHERE authorization_id = ?`,
      ['["not-hex"]', 'egr_test1'],
    );
    expect(repo.get('egr_test1')).toBeNull();
  });
});
