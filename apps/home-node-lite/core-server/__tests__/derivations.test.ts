/**
 * Task 4.54 + 4.55 — identity-derivation orchestrator tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  deriveRootSigningKey,
  derivePersonaSigningKey,
  deriveRotationKey,
  deriveServiceKey,
  derivePersonaDEK,
  mnemonicToSeed,
  generateMnemonic,
} from '@dina/core';

import {
  deriveIdentity,
  SERVICE_INDEX,
  PERSONA_INDEX,
} from '../src/identity/derivations';

function seedFromFixedMnemonic(): Uint8Array {
  // A fresh mnemonic is fine for deterministic tests — same mnemonic
  // on every test → same bytes on every test, since BIP-39 is pure.
  const mnemonic = generateMnemonic();
  return mnemonicToSeed(mnemonic);
}

describe('deriveIdentity (tasks 4.54 + 4.55)', () => {
  describe('return shape', () => {
    it('returns root + rotation + services + derivePersona fn + derivePersonaVaultDEK fn', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      expect(ident.root.privateKey.length).toBe(32);
      expect(ident.root.publicKey.length).toBe(32);
      expect(ident.rotation.privateKey.length).toBe(32);
      // secp256k1 compressed pubkey = 33 bytes.
      expect(ident.rotation.publicKey.length).toBe(33);
      expect(ident.services.core.privateKey.length).toBe(32);
      expect(ident.services.brain.privateKey.length).toBe(32);
      expect(typeof ident.derivePersona).toBe('function');
      expect(typeof ident.derivePersonaVaultDEK).toBe('function');
    });
  });

  describe('byte parity with @dina/core primitives', () => {
    it('root key matches deriveRootSigningKey at the same generation', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed, generation: 3 });
      const direct = deriveRootSigningKey(seed, 3);
      expect(Array.from(ident.root.privateKey)).toEqual(Array.from(direct.privateKey));
      expect(Array.from(ident.root.publicKey)).toEqual(Array.from(direct.publicKey));
    });

    it('rotation key matches deriveRotationKey (secp256k1)', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed, generation: 2 });
      const direct = deriveRotationKey(seed, 2);
      expect(Array.from(ident.rotation.privateKey)).toEqual(Array.from(direct.privateKey));
      expect(Array.from(ident.rotation.publicKey)).toEqual(Array.from(direct.publicKey));
    });

    it('service keys match deriveServiceKey at SERVICE_INDEX.core + SERVICE_INDEX.brain', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      const core = deriveServiceKey(seed, SERVICE_INDEX.core);
      const brain = deriveServiceKey(seed, SERVICE_INDEX.brain);
      expect(Array.from(ident.services.core.privateKey)).toEqual(Array.from(core.privateKey));
      expect(Array.from(ident.services.brain.privateKey)).toEqual(Array.from(brain.privateKey));
    });

    it('persona derivation matches derivePersonaSigningKey', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      const healthKey = ident.derivePersona(PERSONA_INDEX.health);
      const direct = derivePersonaSigningKey(seed, PERSONA_INDEX.health, 0);
      expect(Array.from(healthKey.privateKey)).toEqual(Array.from(direct.privateKey));
    });

    it('persona vault DEK matches derivePersonaDEK', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      const salt = new Uint8Array(32).fill(0x5a);
      const dek = ident.derivePersonaVaultDEK('health', salt);
      const direct = derivePersonaDEK(seed, 'health', salt);
      expect(Array.from(dek)).toEqual(Array.from(direct));
      // HKDF output for SQLCipher use is 32 bytes.
      expect(dek.length).toBe(32);
    });
  });

  describe('determinism', () => {
    it('same seed → same derivations across independent calls', () => {
      const seed = seedFromFixedMnemonic();
      const a = deriveIdentity({ masterSeed: seed });
      const b = deriveIdentity({ masterSeed: seed });
      expect(Array.from(a.root.privateKey)).toEqual(Array.from(b.root.privateKey));
      expect(Array.from(a.rotation.privateKey)).toEqual(Array.from(b.rotation.privateKey));
      expect(Array.from(a.services.core.privateKey)).toEqual(
        Array.from(b.services.core.privateKey),
      );
      expect(Array.from(a.services.brain.privateKey)).toEqual(
        Array.from(b.services.brain.privateKey),
      );
    });

    it('different seeds → different derivations', () => {
      const seedA = seedFromFixedMnemonic();
      const seedB = seedFromFixedMnemonic(); // mnemonicToSeed of a FRESH mnemonic
      const a = deriveIdentity({ masterSeed: seedA });
      const b = deriveIdentity({ masterSeed: seedB });
      expect(Array.from(a.root.privateKey)).not.toEqual(Array.from(b.root.privateKey));
    });
  });

  describe('persona isolation (security property)', () => {
    it('each persona gets a unique signing key', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      const health = ident.derivePersona(PERSONA_INDEX.health);
      const financial = ident.derivePersona(PERSONA_INDEX.financial);
      expect(Array.from(health.privateKey)).not.toEqual(Array.from(financial.privateKey));
    });

    it('each persona gets a unique vault DEK (cross-persona decryption impossible)', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      const salt = new Uint8Array(32).fill(0xaa);
      const healthDEK = ident.derivePersonaVaultDEK('health', salt);
      const financialDEK = ident.derivePersonaVaultDEK('financial', salt);
      expect(Array.from(healthDEK)).not.toEqual(Array.from(financialDEK));
    });

    it('different user salts → different DEK for same persona (per-install isolation)', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      const saltA = new Uint8Array(32).fill(0x01);
      const saltB = new Uint8Array(32).fill(0x02);
      const dekA = ident.derivePersonaVaultDEK('health', saltA);
      const dekB = ident.derivePersonaVaultDEK('health', saltB);
      expect(Array.from(dekA)).not.toEqual(Array.from(dekB));
    });
  });

  describe('generation rotation', () => {
    it('rotating root generation produces a different root key (same seed)', () => {
      const seed = seedFromFixedMnemonic();
      const gen0 = deriveIdentity({ masterSeed: seed, generation: 0 });
      const gen1 = deriveIdentity({ masterSeed: seed, generation: 1 });
      expect(Array.from(gen0.root.privateKey)).not.toEqual(Array.from(gen1.root.privateKey));
      expect(Array.from(gen0.rotation.privateKey)).not.toEqual(Array.from(gen1.rotation.privateKey));
    });

    it('service keys are NOT affected by generation rotation (install-time keys)', () => {
      const seed = seedFromFixedMnemonic();
      const gen0 = deriveIdentity({ masterSeed: seed, generation: 0 });
      const gen1 = deriveIdentity({ masterSeed: seed, generation: 1 });
      // Service keys path is m/9999'/3'/{idx}' — no generation segment,
      // so they stay stable across identity rotation.
      expect(Array.from(gen0.services.core.privateKey)).toEqual(
        Array.from(gen1.services.core.privateKey),
      );
    });

    it('derivePersona honors explicit generation override', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed, generation: 0 });
      const gen0 = ident.derivePersona(PERSONA_INDEX.health, 0);
      const gen1 = ident.derivePersona(PERSONA_INDEX.health, 1);
      expect(Array.from(gen0.privateKey)).not.toEqual(Array.from(gen1.privateKey));
    });
  });

  describe('input validation', () => {
    it('rejects too-short seed', () => {
      expect(() =>
        deriveIdentity({ masterSeed: new Uint8Array(15) }),
      ).toThrow(/at least 16 bytes/);
    });

    it('rejects empty seed', () => {
      expect(() =>
        deriveIdentity({ masterSeed: new Uint8Array(0) }),
      ).toThrow(/at least 16 bytes/);
    });

    it('derivePersona rejects negative or non-integer index', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      expect(() => ident.derivePersona(-1)).toThrow(/non-negative integer/);
      expect(() => ident.derivePersona(1.5)).toThrow(/non-negative integer/);
    });

    it('derivePersonaVaultDEK rejects empty persona name', () => {
      const seed = seedFromFixedMnemonic();
      const ident = deriveIdentity({ masterSeed: seed });
      expect(() => ident.derivePersonaVaultDEK('', new Uint8Array(32))).toThrow(
        /personaName is required/,
      );
    });
  });

  describe('canonical constants', () => {
    it('pins every service-key index: core 0, brain 1, phone approval 2, A2A gateway 3', () => {
      expect({ ...SERVICE_INDEX }).toEqual({ core: 0, brain: 1, phoneApproval: 2, a2aGateway: 3 });
    });

    it('gives no two service-key users the same index', () => {
      const values = Object.values(SERVICE_INDEX);
      expect(new Set(values).size).toBe(values.length);
    });

    it('derives every service key through SERVICE_INDEX, never an inline number', () => {
      // The index-2 collision this table fixed was an inline `deriveServiceKey(seed, 2)`
      // outside it; the table alone cannot see such a call, so scan the sources.
      const root = path.resolve(__dirname, '../../../..');
      const sourceRoots = [
        'apps/home-node-lite/core-server/src',
        'apps/home-node-lite/brain-server/src',
        'apps/mobile/src',
        'packages',
      ];
      const calls: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(entry.name)) {
            const text = fs.readFileSync(full, 'utf8');
            // Calls only: the declaration `function deriveServiceKey(` is not a use.
            for (const m of text.matchAll(/(?<!function )deriveServiceKey\(\s*[^,()]+,\s*([^)]+)\)/g)) {
              calls.push(`${path.relative(root, full)}: ${(m[1] ?? '').trim()}`);
            }
          }
        }
      };
      for (const r of sourceRoots) walk(path.join(root, r));
      expect(calls.length).toBeGreaterThan(0);
      const inline = calls.filter((c) => !/: SERVICE_INDEX\.[A-Za-z]+$/.test(c));
      expect(inline).toEqual([]);
    });

    it('derives distinct keys for every listed service', () => {
      const seed = seedFromFixedMnemonic();
      const keys = Object.values(SERVICE_INDEX).map((i) =>
        Buffer.from(deriveServiceKey(seed, i).privateKey).toString('hex'),
      );
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('SERVICE_INDEX is frozen (no runtime mutation)', () => {
      expect(Object.isFrozen(SERVICE_INDEX)).toBe(true);
    });

    it('PERSONA_INDEX contains canonical 6 personas in canonical order', () => {
      expect(PERSONA_INDEX.consumer).toBe(0);
      expect(PERSONA_INDEX.professional).toBe(1);
      expect(PERSONA_INDEX.social).toBe(2);
      expect(PERSONA_INDEX.health).toBe(3);
      expect(PERSONA_INDEX.financial).toBe(4);
      expect(PERSONA_INDEX.citizen).toBe(5);
    });
  });
});
