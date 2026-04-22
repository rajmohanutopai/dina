/**
 * Task 4.56 — did:plc registration tests.
 *
 * Uses an injected `createFn` to stub the PLC directory call so
 * tests don't need a real PDS.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { mnemonicToSeed, generateMnemonic } from '@dina/core';
import { deriveIdentity } from '../src/identity/derivations';
import {
  ensureDIDPLC,
  DID_FILE_NAME,
  DID_FILE_MODE,
  type PLCCreateFn,
} from '../src/identity/did_plc_registration';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'plc-test-'));
}

function fixedIdentity() {
  const seed = mnemonicToSeed(generateMnemonic());
  const identity = deriveIdentity({ masterSeed: seed });
  return { seed, identity };
}

function stubCreateFn(did = 'did:plc:stub123'): {
  fn: PLCCreateFn;
  calls: Array<Parameters<PLCCreateFn>[0]>;
} {
  const calls: Array<Parameters<PLCCreateFn>[0]> = [];
  const fn: PLCCreateFn = async (params) => {
    calls.push(params);
    return {
      did,
      didKey: 'did:key:z6Mkstub',
      publicKeyMultibase: 'z6Mkstub',
      rotationKeyHex: 'deadbeef',
      operationHash: 'opHash123',
    };
  };
  return { fn, calls };
}

describe('ensureDIDPLC (task 4.56)', () => {
  describe('first boot', () => {
    it('calls createFn and persists did.txt', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const { fn: createFn, calls } = stubCreateFn('did:plc:first-boot-abc');
        const res = await ensureDIDPLC({
          vaultDir: dir,
          identity,
          masterSeed: seed,
          createFn,
        });
        expect(res.kind).toBe('registered');
        if (res.kind === 'registered') {
          expect(res.result.did).toBe('did:plc:first-boot-abc');
        }
        expect(calls.length).toBe(1);
        const persisted = await fs.readFile(path.join(dir, DID_FILE_NAME), 'utf8');
        expect(persisted.trim()).toBe('did:plc:first-boot-abc');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('persisted did.txt is mode 0o600', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const { fn: createFn } = stubCreateFn();
        await ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn });
        const stat = await fs.stat(path.join(dir, DID_FILE_NAME));
        expect(stat.mode & 0o777).toBe(DID_FILE_MODE);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('passes signingKey + masterSeed + optional msgboxEndpoint + handle to createFn', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const { fn: createFn, calls } = stubCreateFn();
        await ensureDIDPLC({
          vaultDir: dir,
          identity,
          masterSeed: seed,
          msgboxEndpoint: 'https://msgbox.example.com',
          handle: 'alice.example',
          createFn,
        });
        expect(calls.length).toBe(1);
        const params = calls[0]!;
        expect(Array.from(params.signingKey)).toEqual(Array.from(identity.root.privateKey));
        expect(Array.from(params.rotationSeed)).toEqual(Array.from(seed));
        expect(params.msgboxEndpoint).toBe('https://msgbox.example.com');
        expect(params.handle).toBe('alice.example');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('creates the vault dir if missing', async () => {
      const parent = await mkTmpDir();
      const dir = path.join(parent, 'not-yet');
      try {
        const { seed, identity } = fixedIdentity();
        const { fn: createFn } = stubCreateFn();
        await ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn });
        const stat = await fs.stat(path.join(dir, DID_FILE_NAME));
        expect(stat.size).toBeGreaterThan(0);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    });

    it('no .tmp- residue after successful write', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const { fn: createFn } = stubCreateFn();
        await ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn });
        const entries = await fs.readdir(dir);
        expect(entries.some((e) => e.startsWith(`.${DID_FILE_NAME}.tmp-`))).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('subsequent boot', () => {
    it('loads the persisted DID without calling createFn', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const { fn: create1 } = stubCreateFn('did:plc:boot-once');
        await ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn: create1 });

        const { fn: create2, calls: secondCalls } = stubCreateFn('did:plc:NOT-USED');
        const res = await ensureDIDPLC({
          vaultDir: dir,
          identity,
          masterSeed: seed,
          createFn: create2,
        });
        expect(res).toEqual({ kind: 'loaded', did: 'did:plc:boot-once' });
        expect(secondCalls.length).toBe(0); // NO second call
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('trims trailing newline / whitespace from persisted file', async () => {
      const dir = await mkTmpDir();
      try {
        await fs.writeFile(path.join(dir, DID_FILE_NAME), '   did:plc:whitespace-test   \n', {
          mode: 0o600,
        });
        const { seed, identity } = fixedIdentity();
        const { fn: createFn, calls } = stubCreateFn();
        const res = await ensureDIDPLC({
          vaultDir: dir,
          identity,
          masterSeed: seed,
          createFn,
        });
        expect(res).toEqual({ kind: 'loaded', did: 'did:plc:whitespace-test' });
        expect(calls.length).toBe(0);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('safety rails', () => {
    it('rejects a did.txt that does NOT start with "did:plc:"', async () => {
      const dir = await mkTmpDir();
      try {
        await fs.writeFile(path.join(dir, DID_FILE_NAME), 'did:key:something-else', {
          mode: 0o600,
        });
        const { seed, identity } = fixedIdentity();
        const { fn: createFn } = stubCreateFn();
        await expect(
          ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn }),
        ).rejects.toThrow(/don't start with "did:plc:"/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects if createFn returns an invalid DID', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const bogus: PLCCreateFn = async () => ({
          did: 'not-a-valid-did',
          didKey: 'did:key:x',
          publicKeyMultibase: 'z',
          rotationKeyHex: 'deadbeef',
          operationHash: 'op',
        });
        await expect(
          ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn: bogus }),
        ).rejects.toThrow(/invalid DID "not-a-valid-did"/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('propagates createFn failure', async () => {
      const dir = await mkTmpDir();
      try {
        const { seed, identity } = fixedIdentity();
        const failing: PLCCreateFn = async () => {
          throw new Error('PDS unreachable');
        };
        await expect(
          ensureDIDPLC({ vaultDir: dir, identity, masterSeed: seed, createFn: failing }),
        ).rejects.toThrow(/PDS unreachable/);
        // No DID file written on failure.
        await expect(fs.stat(path.join(dir, DID_FILE_NAME))).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('input validation', () => {
    it('rejects empty vaultDir', async () => {
      const { seed, identity } = fixedIdentity();
      await expect(
        ensureDIDPLC({ vaultDir: '', identity, masterSeed: seed }),
      ).rejects.toThrow(/vaultDir is required/);
    });

    it('rejects too-short masterSeed', async () => {
      const dir = await mkTmpDir();
      try {
        const { identity } = fixedIdentity();
        await expect(
          ensureDIDPLC({
            vaultDir: dir,
            identity,
            masterSeed: new Uint8Array(8),
          }),
        ).rejects.toThrow(/at least 16 bytes/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
