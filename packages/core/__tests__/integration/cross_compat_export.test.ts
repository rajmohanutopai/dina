/**
 * T10.9 — Cross-compatibility: export archive portability.
 *
 * Verifies that .dina archives created on one platform can be read,
 * verified, and imported on another. Tests the archive format invariants
 * that must hold across mobile ↔ server:
 *
 *   1. Archive magic bytes: "DINA" (0x44 0x49 0x4E 0x41)
 *   2. Version byte: 1
 *   3. AES-256-GCM encryption with Argon2id-derived key
 *   4. Manifest JSON format: header + personas + identity_size_bytes
 *   5. Create → read → verify → import round-trip
 *   6. Wrong passphrase → decryption fails (not silent corruption)
 *   7. Tampered archive → verification fails
 *
 * Source: ARCHITECTURE.md Task 10.9
 */

import {
  createArchive,
  readManifest,
  verifyArchive,
  importArchive,
  setImportHandler,
  resetImportHandler,
  type ArchiveManifest,
} from '../../src/export/archive';

const PASSPHRASE = 'test-passphrase-for-compat';
const WRONG_PASSPHRASE = 'wrong-passphrase';

describe('Cross-Compat Export (10.9)', () => {
  afterEach(() => resetImportHandler());

  describe('archive format invariants', () => {
    it('archive starts with DINA magic bytes', async () => {
      const archive = await createArchive(PASSPHRASE);

      expect(archive[0]).toBe(0x44); // D
      expect(archive[1]).toBe(0x49); // I
      expect(archive[2]).toBe(0x4e); // N
      expect(archive[3]).toBe(0x41); // A
    });

    it('version byte is 1', async () => {
      const archive = await createArchive(PASSPHRASE);
      expect(archive[4]).toBe(1);
    });

    it('archive has valid structure: magic + version + salt_len + salt + wrapped_len + wrapped', async () => {
      const archive = await createArchive(PASSPHRASE);

      // Parse structure
      let offset = 4; // skip magic
      const version = archive[offset++];
      expect(version).toBe(1);

      const saltLen = archive[offset++];
      expect(saltLen).toBeGreaterThan(0);

      offset += saltLen; // skip salt

      // 4-byte LE wrapped length
      const wrappedLen =
        archive[offset] |
        (archive[offset + 1] << 8) |
        (archive[offset + 2] << 16) |
        (archive[offset + 3] << 24);
      offset += 4;

      expect(wrappedLen).toBeGreaterThan(0);
      expect(offset + wrappedLen).toBe(archive.length);
    });
  });

  describe('create → read manifest round-trip', () => {
    it('manifest has correct format field', async () => {
      const archive = await createArchive(PASSPHRASE);
      const manifest = await readManifest(archive, PASSPHRASE);

      expect(manifest.header.format).toBe('dina-archive-v1');
      expect(manifest.header.version).toBe(1);
      expect(manifest.header.created_at).toBeGreaterThan(0);
    });

    it('manifest has personas array', async () => {
      const archive = await createArchive(PASSPHRASE);
      const manifest = await readManifest(archive, PASSPHRASE);

      expect(Array.isArray(manifest.personas)).toBe(true);
    });

    it('manifest has identity_size_bytes', async () => {
      const archive = await createArchive(PASSPHRASE);
      const manifest = await readManifest(archive, PASSPHRASE);

      expect(typeof manifest.identity_size_bytes).toBe('number');
    });
  });

  describe('verify archive', () => {
    it('valid archive → true', async () => {
      const archive = await createArchive(PASSPHRASE);
      const valid = await verifyArchive(archive, PASSPHRASE);
      expect(valid).toBe(true);
    });

    it('wrong passphrase → false', async () => {
      const archive = await createArchive(PASSPHRASE);
      const valid = await verifyArchive(archive, WRONG_PASSPHRASE);
      expect(valid).toBe(false);
    });

    it('tampered archive → false', async () => {
      const archive = await createArchive(PASSPHRASE);

      // Tamper with the encrypted data (last bytes)
      const tampered = new Uint8Array(archive);
      tampered[tampered.length - 1] ^= 0xff;
      tampered[tampered.length - 2] ^= 0xff;

      const valid = await verifyArchive(tampered, PASSPHRASE);
      expect(valid).toBe(false);
    });

    it('truncated archive → false', async () => {
      const archive = await createArchive(PASSPHRASE);
      const truncated = archive.slice(0, archive.length - 10);

      const valid = await verifyArchive(truncated, PASSPHRASE);
      expect(valid).toBe(false);
    });

    it('corrupt magic → false', async () => {
      const archive = await createArchive(PASSPHRASE);
      const corrupt = new Uint8Array(archive);
      corrupt[0] = 0x00;

      const valid = await verifyArchive(corrupt, PASSPHRASE);
      expect(valid).toBe(false);
    });
  });

  describe('import round-trip', () => {
    it('create → import succeeds with correct passphrase', async () => {
      const archive = await createArchive(PASSPHRASE);

      let imported = false;
      setImportHandler(async (manifest) => {
        imported = true;
        expect(manifest.header.format).toBe('dina-archive-v1');
      });

      await importArchive(archive, PASSPHRASE);
      expect(imported).toBe(true);
    });

    it('import with wrong passphrase throws', async () => {
      const archive = await createArchive(PASSPHRASE);

      await expect(importArchive(archive, WRONG_PASSPHRASE)).rejects.toThrow();
    });

    it('import without handler succeeds silently (dry run)', async () => {
      const archive = await createArchive(PASSPHRASE);

      // No handler — import validates but does nothing
      await expect(importArchive(archive, PASSPHRASE)).resolves.not.toThrow();
    });
  });

  describe('cross-platform portability', () => {
    it('archive bytes are deterministic except for salt + nonce', async () => {
      const a1 = await createArchive(PASSPHRASE);
      const a2 = await createArchive(PASSPHRASE);

      // Both have same magic + version
      expect(a1.slice(0, 5)).toEqual(a2.slice(0, 5));

      // But different content (random salt + nonce)
      expect(a1.length).toBeGreaterThan(10);
      expect(a2.length).toBeGreaterThan(10);
      // Archives differ because of random salt/nonce
      expect(Buffer.from(a1).equals(Buffer.from(a2))).toBe(false);
    });

    it('both archives decrypt to same manifest', async () => {
      const a1 = await createArchive(PASSPHRASE);
      const a2 = await createArchive(PASSPHRASE);

      const m1 = await readManifest(a1, PASSPHRASE);
      const m2 = await readManifest(a2, PASSPHRASE);

      expect(m1.header.format).toBe(m2.header.format);
      expect(m1.header.version).toBe(m2.header.version);
    });
  });
});
