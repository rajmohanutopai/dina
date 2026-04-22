/**
 * T1I.1 — Encrypted export archive (.dina format).
 *
 * Category A: fixture-based. Verifies archive creation, manifest reading,
 * import, verification, and round-trip.
 *
 * Source: core/test/portability_test.go
 */

import {
  createArchive,
  readManifest,
  importArchive,
  verifyArchive,
  setImportHandler,
  resetImportHandler,
  validatePath,
  isPathSafe,
  checkCompatibility,
  listArchiveContents,
} from '../../src/export/archive';
import type { ArchiveManifest } from '../../src/export/archive';
import { TEST_PASSPHRASE, TEST_PASSPHRASE_WRONG } from '@dina/test-harness';

describe('Export Archive (.dina format)', () => {
  let archive: Uint8Array;

  beforeAll(async () => {
    archive = await createArchive(TEST_PASSPHRASE);
  }, 30_000);

  afterEach(() => resetImportHandler());

  describe('createArchive', () => {
    it('creates an encrypted archive', () => {
      expect(archive).toBeInstanceOf(Uint8Array);
    });

    it('archive is non-empty bytes', () => {
      expect(archive.length).toBeGreaterThan(10);
    });

    it('archive starts with DINA magic', () => {
      const magic = String.fromCharCode(...archive.slice(0, 4));
      expect(magic).toBe('DINA');
    });

    it('archive has version byte', () => {
      expect(archive[4]).toBe(1);
    });

    it('different passphrases produce different archives', async () => {
      const archive2 = await createArchive('other passphrase');
      expect(Buffer.from(archive)).not.toEqual(Buffer.from(archive2));
    }, 30_000);
  });

  describe('readManifest', () => {
    it('reads manifest without decrypting vault data', async () => {
      const manifest = await readManifest(archive, TEST_PASSPHRASE);
      expect(manifest.header).toBeDefined();
      expect(manifest.personas).toBeDefined();
    }, 30_000);

    it('manifest includes header with version and format', async () => {
      const manifest = await readManifest(archive, TEST_PASSPHRASE);
      expect(manifest.header.version).toBe(1);
      expect(manifest.header.format).toBe('dina-archive-v1');
      expect(manifest.header.created_at).toBeGreaterThan(0);
    }, 30_000);

    it('manifest has persona list', async () => {
      const manifest = await readManifest(archive, TEST_PASSPHRASE);
      expect(Array.isArray(manifest.personas)).toBe(true);
    }, 30_000);

    it('rejects wrong passphrase', async () => {
      await expect(readManifest(archive, TEST_PASSPHRASE_WRONG)).rejects.toThrow();
    }, 30_000);

    it('rejects corrupted archive', async () => {
      await expect(readManifest(new Uint8Array([0xde, 0xad]), TEST_PASSPHRASE)).rejects.toThrow();
    });
  });

  describe('importArchive', () => {
    it('decrypts and validates archive', async () => {
      await expect(importArchive(archive, TEST_PASSPHRASE)).resolves.toBeUndefined();
    }, 30_000);

    it('rejects wrong passphrase', async () => {
      await expect(importArchive(archive, TEST_PASSPHRASE_WRONG)).rejects.toThrow();
    }, 30_000);

    it('rejects corrupted archive', async () => {
      await expect(importArchive(new Uint8Array([0xba, 0xad]), TEST_PASSPHRASE)).rejects.toThrow();
    });

    it('calls import handler with manifest', async () => {
      let receivedManifest: ArchiveManifest | null = null;
      setImportHandler(async (manifest) => {
        receivedManifest = manifest;
      });
      await importArchive(archive, TEST_PASSPHRASE);
      expect(receivedManifest).not.toBeNull();
      expect(receivedManifest!.header.format).toBe('dina-archive-v1');
    }, 30_000);

    it('succeeds without handler (dry-run)', async () => {
      resetImportHandler();
      await expect(importArchive(archive, TEST_PASSPHRASE)).resolves.toBeUndefined();
    }, 30_000);
  });

  describe('verifyArchive', () => {
    it('verifies a valid archive', async () => {
      expect(await verifyArchive(archive, TEST_PASSPHRASE)).toBe(true);
    }, 30_000);

    it('rejects corrupted archive', async () => {
      expect(await verifyArchive(new Uint8Array([0xde, 0xad]), TEST_PASSPHRASE)).toBe(false);
    });

    it('rejects wrong passphrase', async () => {
      expect(await verifyArchive(archive, TEST_PASSPHRASE_WRONG)).toBe(false);
    }, 30_000);
  });

  describe('round-trip: create → verify → import', () => {
    it('archive created → verified → imported → manifest matches', async () => {
      const fresh = await createArchive(TEST_PASSPHRASE);
      expect(await verifyArchive(fresh, TEST_PASSPHRASE)).toBe(true);

      let imported: ArchiveManifest | null = null;
      setImportHandler(async (m) => {
        imported = m;
      });
      await importArchive(fresh, TEST_PASSPHRASE);

      expect(imported).not.toBeNull();
      expect(imported!.header.format).toBe('dina-archive-v1');
    }, 60_000);
  });

  describe('path traversal protection', () => {
    it('accepts valid filenames', () => {
      expect(isPathSafe('general.sqlite')).toBe(true);
      expect(isPathSafe('health_persona.db')).toBe(true);
      expect(isPathSafe('identity.sqlite')).toBe(true);
    });

    it('rejects directory separators (layer 1)', () => {
      expect(validatePath('../../etc/passwd')).toContain('directory separator');
      expect(validatePath('foo/bar.sqlite')).toContain('directory separator');
      expect(validatePath('foo\\bar.sqlite')).toContain('directory separator');
    });

    it('rejects parent directory traversal (layer 2)', () => {
      expect(validatePath('..')).toContain('parent directory');
      expect(validatePath('..sqlite')).toContain('parent directory');
    });

    it('rejects null bytes (layer 4)', () => {
      expect(validatePath('file\0.sqlite')).toContain('null byte');
    });

    it('rejects empty path', () => {
      expect(validatePath('')).toContain('empty');
    });

    it('isPathSafe returns boolean', () => {
      expect(isPathSafe('valid.db')).toBe(true);
      expect(isPathSafe('../bad')).toBe(false);
    });
  });

  describe('checkCompatibility (header-only)', () => {
    it('valid archive → compatible', () => {
      const result = checkCompatibility(archive);
      expect(result.compatible).toBe(true);
      expect(result.version).toBe(1);
    });

    it('too short → incompatible', () => {
      const result = checkCompatibility(new Uint8Array([0x44, 0x49]));
      expect(result.compatible).toBe(false);
      expect(result.reason).toContain('too short');
    });

    it('wrong magic → incompatible', () => {
      const fake = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 0x10]);
      const result = checkCompatibility(fake);
      expect(result.compatible).toBe(false);
      expect(result.reason).toContain('Invalid magic');
    });

    it('wrong version → incompatible with version number', () => {
      const wrongVersion = new Uint8Array(archive);
      wrongVersion[4] = 99; // bogus version
      const result = checkCompatibility(wrongVersion);
      expect(result.compatible).toBe(false);
      expect(result.version).toBe(99);
      expect(result.reason).toContain('Unsupported version');
    });

    it('does not require passphrase', () => {
      // checkCompatibility works on raw bytes — no Argon2id needed
      const result = checkCompatibility(archive);
      expect(result.compatible).toBe(true);
    });
  });

  describe('listArchiveContents', () => {
    it('lists personas and metadata', async () => {
      const contents = await listArchiveContents(archive, TEST_PASSPHRASE);
      expect(contents.total_personas).toBe(0); // empty archive
      expect(contents.personas).toEqual([]);
      expect(contents.identity_size_bytes).toBe(0);
      expect(contents.created_at).toBeGreaterThan(0);
    }, 30_000);

    it('rejects wrong passphrase', async () => {
      await expect(listArchiveContents(archive, TEST_PASSPHRASE_WRONG)).rejects.toThrow();
    }, 30_000);
  });
});
