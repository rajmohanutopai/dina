/**
 * Task 3.51 — Phase 3g smoke test.
 *
 * End-to-end composition proof: import only from `@dina/adapters-node`
 * (the meta barrel) and `@dina/core` (the shared runtime), and walk
 * through the happy path a real `apps/home-node-lite/core-server` would
 * use:
 *
 *   1. **Crypto bytes are consistent.** An Ed25519 key derived via the
 *      adapter matches the same derivation done through `@dina/core`
 *      (both delegate to `@noble/*` — but the point is to prove the
 *      composition works at the *import level*: apps pull `Crypto` from
 *      `@dina/adapters-node`, not from `@dina/crypto-node` directly).
 *   2. **Filesystem persona-dir setup.** Create a vault root + per-persona
 *      subdirs via `FileSystem`, write/read files through the same
 *      adapter, validate the safe-write + rename semantics.
 *   3. **Keystore round-trip.** Persist a derived key via `FileKeystore`
 *      to the vault root, read it back, confirm byte equality.
 *   4. **Vault write + query.** Use `@dina/core`'s in-memory vault CRUD
 *      (storeItem + queryVault) — the real SQLCipher + FTS5 lands when
 *      `@dina/storage-node` ships (Phase 3a, tasks 3.6-3.19), and this
 *      smoke will flip over to it then. For now, proving the API
 *      contract works end-to-end.
 *   5. **Signed HTTP request composition.** `HttpClient` + signer from
 *      `@dina/adapters-node` can be constructed with `Crypto`'s Ed25519
 *      signer injected — this is the wiring shape `apps/home-node-lite`
 *      will use for Brain → Core calls.
 *
 * **Not a deep integration test.** Those live in `@dina/core`'s own
 * `__tests__/lifecycle/unlock.test.ts` and friends. This is the
 * composition-only smoke that proves the adapters-node barrel is
 * the right shape for the app tier.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  FileSystem,
  FileKeystore,
  Crypto,
  HttpClient,
  createCanonicalRequestSigner,
} from '@dina/adapters-node';
import {
  derivePath as coreDerivePath,
  mnemonicToSeed,
  generateMnemonic,
  validateMnemonic,
  storeItem,
  queryVault,
  clearVaults,
} from '@dina/core';

// Argon2id through adapter is slow; smoke is allowed more budget.
jest.setTimeout(30_000);

describe('adapters-node × @dina/core — Phase 3g smoke (task 3.51)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dina-smoke-'));
    clearVaults();
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('(1) Crypto adapter derives the same Ed25519 keypair as @dina/core', async () => {
    const mnemonic = generateMnemonic();
    expect(validateMnemonic(mnemonic)).toBe(true);

    // Derive the same 64-byte seed both ways (both wrap BIP-39 via @noble).
    const seed = mnemonicToSeed(mnemonic);
    expect(seed.length).toBe(64);

    // Adapter's derivation (async port).
    const crypto = new Crypto();
    const adapterKey = await crypto.ed25519DerivePath(seed, "m/9999'/0'/0'");
    // Core's direct derivation (sync).
    const coreKey = coreDerivePath(seed, "m/9999'/0'/0'");

    // Byte-for-byte parity — same @noble libraries under the hood.
    expect(Array.from(adapterKey.privateKey)).toEqual(Array.from(coreKey.privateKey));
    expect(Array.from(adapterKey.publicKey)).toEqual(Array.from(coreKey.publicKey));
    expect(Array.from(adapterKey.chainCode)).toEqual(Array.from(coreKey.chainCode));
  });

  it('(2) FileSystem creates + reads a persona dir via the meta barrel', async () => {
    const filesystem = new FileSystem();
    const personaDir = path.join(vaultRoot, 'personas', 'general');
    await filesystem.mkdir(personaDir, { recursive: true });

    // Safe-write through the adapter (tmp + rename semantics).
    const manifestPath = path.join(personaDir, 'manifest.json');
    await filesystem.writeFile(manifestPath, JSON.stringify({ version: 1, tier: 'default' }));

    // Round-trip read.
    const text = await filesystem.readFileText(manifestPath);
    expect(JSON.parse(text)).toEqual({ version: 1, tier: 'default' });

    // No tmp-file littering after successful safe-write.
    const entries = await filesystem.readdir(personaDir);
    expect(entries.some((e) => e.startsWith('.manifest.json.tmp-'))).toBe(false);
  });

  it('(3) FileKeystore round-trips a derived key into the vault root', async () => {
    const keystore = new FileKeystore({ rootDir: vaultRoot });
    const crypto = new Crypto();
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = i ^ 0x42;
    const key = await crypto.ed25519DerivePath(seed, "m/9999'/1'/0'/0'");

    // Keystore stores UTF-8 strings — persist the key as hex.
    const hex = Array.from(key.privateKey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await keystore.put('dina.persona.general.sign', hex);

    const read = await keystore.get('dina.persona.general.sign');
    expect(read).toBe(hex);
    // Confirms the stored file lives under vaultRoot (persisted on disk,
    // not in-memory).
    const keystoreFiles = await fs.readdir(vaultRoot);
    expect(keystoreFiles.length).toBeGreaterThan(0);
  });

  it('(4) Vault write + query happy path (storeItem + queryVault)', () => {
    const persona = 'general';
    const id = storeItem(persona, {
      type: 'note',
      source: 'smoke-test',
      summary: 'Reminder to review SFTransit demo',
      body: 'Check the bus schedule for route 42 tomorrow morning',
      sender: 'self',
      retrieval_policy: 'normal',
    });
    expect(id).toBeTruthy();

    // FTS-shape keyword query (current in-memory impl; SQLite FTS5 when
    // storage-node lands).
    const results = queryVault(persona, { text: 'bus schedule', limit: 10, mode: 'fts5' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === id)).toBe(true);

    // Per-persona isolation: same query on a different persona returns nothing.
    const other = queryVault('health', { text: 'bus schedule', limit: 10, mode: 'fts5' });
    expect(other.length).toBe(0);
  });

  it('(5) HttpClient + signer composition (no network call)', async () => {
    // This is the wiring Brain → Core will use via HttpCoreTransport.
    // No real network — we only prove the headers are buildable end-to-end
    // from the meta barrel's exports.
    const crypto = new Crypto();
    const seed = new Uint8Array(32).fill(0x11);
    const { privateKey } = await crypto.ed25519DerivePath(seed, "m/9999'/3'/0'");

    const signer = createCanonicalRequestSigner({
      did: 'did:plc:smoke-test',
      privateKey,
      sign: (priv, msg) => crypto.ed25519Sign(priv, msg),
      nonce: () => new Uint8Array(16).fill(0xaa),
      now: () => 1700000000000,
    });

    const signed = await signer({
      method: 'POST',
      path: '/v1/vault/store',
      query: '',
      body: new TextEncoder().encode('{"item": "smoke"}'),
    });

    expect(signed.did).toBe('did:plc:smoke-test');
    expect(signed.timestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(signed.nonce).toMatch(/^[0-9a-f]{32}$/);
    // Ed25519 signature is 64 bytes = 128 hex chars.
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/);

    // HttpClient constructs cleanly from the meta barrel.
    const http = new HttpClient({ timeoutMs: 5000 });
    expect(http).toBeInstanceOf(HttpClient);
  });
});
