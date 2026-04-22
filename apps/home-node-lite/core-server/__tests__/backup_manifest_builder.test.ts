/**
 * backup_manifest_builder tests.
 */

import {
  BackupManifestError,
  DEFAULT_SCHEMA_VERSION,
  buildBackupManifest,
  recomputeSelfHash,
  type BackupEntry,
  type BackupManifestInput,
  type BackupMeta,
} from '../src/brain/backup_manifest_builder';

function entry(overrides: Partial<BackupEntry> = {}): BackupEntry {
  return {
    path: 'vault/general.sqlite',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    kind: 'vault',
    ...overrides,
  };
}

function meta(overrides: Partial<BackupMeta> = {}): BackupMeta {
  return {
    did: 'did:plc:alonso',
    createdAtSec: 1_700_000_000,
    ...overrides,
  };
}

function input(overrides: Partial<BackupManifestInput> = {}): BackupManifestInput {
  return {
    meta: meta(),
    entries: [entry()],
    ...overrides,
  };
}

describe('buildBackupManifest — input validation', () => {
  it.each([
    ['null input', null],
    ['non-object input', 'bogus'],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      buildBackupManifest(bad as unknown as BackupManifestInput),
    ).toThrow(BackupManifestError);
  });

  it.each([
    ['null meta', { ...input(), meta: null as unknown as BackupMeta }],
    ['non-DID did', { ...input(), meta: { ...meta(), did: 'alonso' } }],
    ['zero createdAtSec', { ...input(), meta: { ...meta(), createdAtSec: 0 } }],
    ['fraction schemaVersion', { ...input(), meta: { ...meta(), schemaVersion: 1.5 } }],
    ['zero schemaVersion', { ...input(), meta: { ...meta(), schemaVersion: 0 } }],
    ['non-array personas', { ...input(), meta: { ...meta(), personas: 'general' as unknown as string[] } }],
    ['empty-string persona entry', { ...input(), meta: { ...meta(), personas: ['ok', ''] } }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => buildBackupManifest(bad)).toThrow(/invalid_meta/);
  });

  it('rejects empty entries', () => {
    expect(() => buildBackupManifest(input({ entries: [] }))).toThrow(/empty_entries/);
  });

  it.each([
    ['missing path', { sizeBytes: 1, sha256: 'a'.repeat(64), kind: 'x' }],
    ['empty path', { path: '', sizeBytes: 1, sha256: 'a'.repeat(64), kind: 'x' }],
    ['negative size', { path: 'p', sizeBytes: -1, sha256: 'a'.repeat(64), kind: 'x' }],
    ['non-integer size', { path: 'p', sizeBytes: 1.5, sha256: 'a'.repeat(64), kind: 'x' }],
    ['wrong-length sha256', { path: 'p', sizeBytes: 1, sha256: 'abc', kind: 'x' }],
    ['uppercase hex sha256', { path: 'p', sizeBytes: 1, sha256: 'A'.repeat(64), kind: 'x' }],
    ['missing kind', { path: 'p', sizeBytes: 1, sha256: 'a'.repeat(64) }],
    ['empty kind', { path: 'p', sizeBytes: 1, sha256: 'a'.repeat(64), kind: '' }],
  ] as const)('rejects entry — %s', (_l, bad) => {
    expect(() =>
      buildBackupManifest(input({ entries: [bad as unknown as BackupEntry] })),
    ).toThrow(/invalid_entry/);
  });

  it('duplicate path → duplicate_path', () => {
    expect(() =>
      buildBackupManifest(
        input({
          entries: [
            entry({ path: 'a' }),
            entry({ path: 'a', sha256: 'b'.repeat(64) }),
          ],
        }),
      ),
    ).toThrow(/duplicate_path/);
  });

  it('non-array entries → invalid_input', () => {
    expect(() =>
      buildBackupManifest({
        meta: meta(),
        entries: 'bogus' as unknown as BackupEntry[],
      }),
    ).toThrow(/invalid_input/);
  });
});

describe('buildBackupManifest — happy path', () => {
  it('produces manifest with all expected fields', () => {
    const m = buildBackupManifest(
      input({
        meta: meta({ sourceHost: 'laptop.local', note: 'monthly', personas: ['general', 'health'] }),
        entries: [entry({ path: 'a', sha256: 'a'.repeat(64) }), entry({ path: 'b', sha256: 'b'.repeat(64), kind: 'identity' })],
      }),
    );
    expect(m.version).toBe(DEFAULT_SCHEMA_VERSION);
    expect(m.did).toBe('did:plc:alonso');
    expect(m.createdAtSec).toBe(1_700_000_000);
    expect(m.sourceHost).toBe('laptop.local');
    expect(m.note).toBe('monthly');
    expect(m.personas.sort()).toEqual(['general', 'health']);
    expect(m.entries).toHaveLength(2);
    expect(m.selfHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sourceHost + note default to null when absent', () => {
    const m = buildBackupManifest(input());
    expect(m.sourceHost).toBeNull();
    expect(m.note).toBeNull();
  });

  it('custom schemaVersion honoured', () => {
    const m = buildBackupManifest(
      input({ meta: meta({ schemaVersion: 5 }) }),
    );
    expect(m.version).toBe(5);
  });

  it('personas sorted + deduplicated is NOT enforced (dup persona entries allowed)', () => {
    // Strictly the sort preserves duplicates, but builder spec is
    // "sort by name" — no dedup. Confirm that contract.
    const m = buildBackupManifest(
      input({ meta: meta({ personas: ['health', 'general', 'health'] }) }),
    );
    expect(m.personas).toEqual(['general', 'health', 'health']);
  });
});

describe('buildBackupManifest — entry ordering + totals', () => {
  it('entries sorted by path (lexicographic)', () => {
    const m = buildBackupManifest(
      input({
        entries: [
          entry({ path: 'z/last' }),
          entry({ path: 'a/first', sha256: 'b'.repeat(64) }),
          entry({ path: 'm/middle', sha256: 'c'.repeat(64) }),
        ],
      }),
    );
    expect(m.entries.map((e) => e.path)).toEqual(['a/first', 'm/middle', 'z/last']);
  });

  it('fileCount + byteCount aggregated', () => {
    const m = buildBackupManifest(
      input({
        entries: [
          entry({ path: 'a', sizeBytes: 100 }),
          entry({ path: 'b', sizeBytes: 200, sha256: 'b'.repeat(64) }),
          entry({ path: 'c', sizeBytes: 300, sha256: 'c'.repeat(64) }),
        ],
      }),
    );
    expect(m.totals.fileCount).toBe(3);
    expect(m.totals.byteCount).toBe(600);
  });

  it('byKind tallies entries per kind', () => {
    const m = buildBackupManifest(
      input({
        entries: [
          entry({ path: 'a', kind: 'vault' }),
          entry({ path: 'b', kind: 'vault', sha256: 'b'.repeat(64) }),
          entry({ path: 'c', kind: 'identity', sha256: 'c'.repeat(64) }),
        ],
      }),
    );
    expect(m.totals.byKind).toEqual({ vault: 2, identity: 1 });
  });

  it('zero-byte file allowed', () => {
    const m = buildBackupManifest(
      input({ entries: [entry({ sizeBytes: 0 })] }),
    );
    expect(m.totals.byteCount).toBe(0);
  });
});

describe('buildBackupManifest — selfHash', () => {
  it('same input → same selfHash (deterministic)', () => {
    const m1 = buildBackupManifest(input());
    const m2 = buildBackupManifest(input());
    expect(m1.selfHash).toBe(m2.selfHash);
  });

  it('different entry list order → same selfHash (canonical sort)', () => {
    const a = buildBackupManifest(
      input({
        entries: [
          entry({ path: 'a' }),
          entry({ path: 'b', sha256: 'b'.repeat(64) }),
        ],
      }),
    );
    const b = buildBackupManifest(
      input({
        entries: [
          entry({ path: 'b', sha256: 'b'.repeat(64) }),
          entry({ path: 'a' }),
        ],
      }),
    );
    expect(a.selfHash).toBe(b.selfHash);
  });

  it('changing any entry changes the selfHash', () => {
    const a = buildBackupManifest(input());
    const b = buildBackupManifest(
      input({ entries: [entry({ sizeBytes: 9999 })] }),
    );
    expect(a.selfHash).not.toBe(b.selfHash);
  });

  it('recomputeSelfHash matches builder output for an unmodified manifest', () => {
    const m = buildBackupManifest(input());
    expect(recomputeSelfHash(m)).toBe(m.selfHash);
  });

  it('tampering detected: recomputed hash differs when entries mutated', () => {
    const m = buildBackupManifest(input());
    m.entries[0]!.sizeBytes = 9_999_999;
    expect(recomputeSelfHash(m)).not.toBe(m.selfHash);
  });
});

describe('buildBackupManifest — defensive copy', () => {
  it('entries + personas are copies — mutating output does not affect input', () => {
    const entries: BackupEntry[] = [entry()];
    const personas = ['general'];
    const m = buildBackupManifest(
      input({
        meta: meta({ personas }),
        entries,
      }),
    );
    m.entries[0]!.path = 'hacked';
    m.personas.push('hacked');
    expect(entries[0]!.path).toBe('vault/general.sqlite');
    expect(personas).toEqual(['general']);
  });
});
