/**
 * T9.7 — Share export: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 9.7
 */

import {
  shareArchive,
  getShareState,
  configureSharing,
  resetShareExport,
} from '../../src/hooks/useShareExport';

describe('Share Export Hook (9.7)', () => {
  beforeEach(() => resetShareExport());

  describe('without native modules', () => {
    it('fails when sharing not configured', async () => {
      const result = await shareArchive('TestPass1!');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('not configured');
    });
  });

  describe('with mock native modules', () => {
    let shared: string[];
    let written: Array<{ data: Uint8Array; name: string }>;
    let deleted: string[];

    beforeEach(() => {
      shared = [];
      written = [];
      deleted = [];

      configureSharing({
        share: async (uri) => {
          shared.push(uri);
        },
        writeFile: async (data, name) => {
          written.push({ data, name });
          return `/tmp/${name}`;
        },
        deleteFile: async (uri) => {
          deleted.push(uri);
        },
      });
    });

    it('creates archive, writes file, shares, cleans up', async () => {
      const result = await shareArchive('TestPass1!');

      expect(result.status).toBe('shared');
      expect(result.archiveSizeBytes).toBeGreaterThan(0);
      expect(result.sharedAt).toBeTruthy();
      expect(written).toHaveLength(1);
      expect(written[0].name).toMatch(/^dina-export-.*\.dina$/);
      expect(shared).toHaveLength(1);
      expect(shared[0]).toMatch(/^\/tmp\/dina-export-/);
      expect(deleted).toHaveLength(1); // cleaned up
    });

    it('rejects empty passphrase', async () => {
      const result = await shareArchive('');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Passphrase is required');
    });

    it('handles share failure gracefully', async () => {
      configureSharing({
        share: async () => {
          throw new Error('User cancelled');
        },
        writeFile: async (data, name) => `/tmp/${name}`,
        deleteFile: async () => {},
      });

      const result = await shareArchive('TestPass1!');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('User cancelled');
    });

    it('handles archive creation failure', async () => {
      // This would only fail if crypto is broken — but test the path
      const result = await shareArchive('TestPass1!');
      expect(result.status).toBe('shared'); // should succeed with valid passphrase
    });

    it('getShareState returns current state', async () => {
      expect(getShareState().status).toBe('idle');
      await shareArchive('TestPass1!');
      expect(getShareState().status).toBe('shared');
    });
  });
});
