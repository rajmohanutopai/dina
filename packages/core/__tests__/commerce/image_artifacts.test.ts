/**
 * §6's ingest boundary: malformed, decompression-bomb, oversize and
 * wrong-MIME each refused AT INGEST — and the bomb case additionally
 * proves the declared allocation never happened, because the re-encoder
 * (the only component that decodes) records its invocations and the bomb
 * never reaches it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  ingestCommerceImage,
  InMemoryCommerceImageArtifactRepository,
  installImageReencoder,
  MAX_AGGREGATE_IMAGE_BYTES,
  MAX_PAGE_IMAGE_BYTES,
  parseImageHeader,
  revalidateStoredArtifact,
  SQLiteCommerceImageArtifactRepository,
  type CommerceImageArtifactRepository,
  type CommerceImageMime,
} from '../../src/commerce/image_artifacts';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Byte fixtures, constructed rather than shipped: the header parser reads
// structure, and structure is what these state precisely.
// ---------------------------------------------------------------------------

function pngBytes(width: number, height: number, extraChunk?: string): Uint8Array {
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const chunk = (type: string, data: number[]): number[] => [
    ...u32(data.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0, 0, 0, 0, // CRC, unchecked by the bounded parser
  ];
  out.push(...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]));
  if (extraChunk !== undefined) out.push(...chunk(extraChunk, [0, 0, 0, 1]));
  out.push(...chunk('IDAT', [1, 2, 3]));
  out.push(...chunk('IEND', []));
  return new Uint8Array(out);
}

function jpegBytes(width: number, height: number): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  out.push(0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46); // APP0, length 4
  // SOF0: length 11, precision 8, height, width, 1 component
  out.push(0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01, 0x11);
  out.push(0xff, 0xda, 0x00, 0x02); // SOS
  return new Uint8Array(out);
}

/** A re-encoder that records invocations and visibly strips: it appends
 *  nothing and returns DIFFERENT bytes (a fresh minimal image), the way a
 *  real decode+re-encode never returns the input. */
function makeReencoder(): {
  invocations: Uint8Array[];
  restore: () => void;
} {
  const invocations: Uint8Array[] = [];
  installImageReencoder((bytes: Uint8Array, mime: CommerceImageMime) => {
    invocations.push(bytes);
    const stripped = mime === 'image/png' ? pngBytes(100, 80) : jpegBytes(100, 80);
    return Promise.resolve({ bytes: stripped, mime });
  });
  return { invocations, restore: () => installImageReencoder(null) };
}

afterEach(() => {
  installImageReencoder(null);
});

// ---------------------------------------------------------------------------
// Phase 1 in isolation
// ---------------------------------------------------------------------------

describe('the bounded header parse', () => {
  it('reads real dimensions from PNG and JPEG', () => {
    expect(parseImageHeader(pngBytes(640, 480))).toEqual({
      ok: true,
      mime: 'image/png',
      width: 640,
      height: 480,
    });
    expect(parseImageHeader(jpegBytes(1024, 768))).toEqual({
      ok: true,
      mime: 'image/jpeg',
      width: 1024,
      height: 768,
    });
  });

  it('WRONG MIME: refuses anything that is not a photograph', () => {
    expect(parseImageHeader(new TextEncoder().encode('%PDF-1.4 not an image'))).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('wrong_mime'),
    });
  });

  it('DECOMPRESSION BOMB: a small file declaring an enormous image is refused undecoded', () => {
    const bomb = pngBytes(50000, 50000); // ~10 GB decoded, ~90 bytes on disk
    expect(parseImageHeader(bomb)).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('decompression_bomb'),
    });
  });

  it('refuses an animated PNG — a photograph has one frame', () => {
    expect(parseImageHeader(pngBytes(640, 480, 'acTL'))).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('animated'),
    });
  });

  it('MALFORMED: truncation and marker desync are refused', () => {
    expect(parseImageHeader(pngBytes(640, 480).slice(0, 20))).toMatchObject({ ok: false });
    const desync = jpegBytes(640, 480);
    desync[2] = 0x00; // the byte after SOI is not a marker
    expect(parseImageHeader(desync)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

describe('ingest', () => {
  it('stores the STRIPPED bytes: hash and length are the re-encoded artifact, never the camera bytes', async () => {
    const repo = new InMemoryCommerceImageArtifactRepository();
    const { invocations } = makeReencoder();
    const camera = pngBytes(640, 480);

    const result = await ingestCommerceImage({
      repository: repo,
      ownerDraftId: 'draft-1',
      lane: 'catalog',
      pageIndex: 0,
      bytes: camera,
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(invocations.length).toBe(1);
    const stored = repo.getBytes(result.artifact.artifactId);
    expect(stored).not.toBeNull();
    // The stored artifact is the stripped one — different bytes, and the
    // hash the manifest will commit to is over THOSE.
    expect(bytesToHex(sha256(stored as Uint8Array))).toBe(result.artifact.contentHash);
    expect(result.artifact.contentHash).not.toBe(bytesToHex(sha256(camera)));
  });

  it('DECOMPRESSION BOMB at ingest: refused with the re-encoder never invoked', async () => {
    const repo = new InMemoryCommerceImageArtifactRepository();
    const { invocations } = makeReencoder();
    const result = await ingestCommerceImage({
      repository: repo,
      ownerDraftId: 'draft-1',
      lane: 'catalog',
      pageIndex: 0,
      bytes: pngBytes(50000, 50000),
      nowMs: T0,
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('decompression_bomb'),
    });
    // The proof the design asks for: rejection WITHOUT the declared
    // allocation ever happening. Nothing that decodes ever saw the bytes.
    expect(invocations.length).toBe(0);
  });

  it('OVERSIZE: per-page and per-draft aggregate ceilings both refuse', async () => {
    const repo = new InMemoryCommerceImageArtifactRepository();
    makeReencoder();
    const oversize = new Uint8Array(MAX_PAGE_IMAGE_BYTES + 1);
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'catalog',
        pageIndex: 0,
        bytes: oversize,
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: 'oversize_page' });

    // Fill the draft near the aggregate ceiling with stored artifacts, then
    // one more page over the line refuses.
    repo.put(
      {
        artifactId: 'img_existing',
        ownerDraftId: 'draft-1',
        lane: 'catalog',
        pageIndex: 0,
        mime: 'image/png',
        byteLength: MAX_AGGREGATE_IMAGE_BYTES - 10,
        contentHash: 'a'.repeat(64),
        createdAtMs: T0,
      },
      new Uint8Array(8),
    );
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'catalog',
        pageIndex: 1,
        bytes: pngBytes(640, 480),
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: 'oversize_draft_aggregate' });
  });

  it('MALFORMED and WRONG-MIME: refused at ingest', async () => {
    const repo = new InMemoryCommerceImageArtifactRepository();
    const { invocations } = makeReencoder();
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'order',
        pageIndex: 0,
        bytes: new TextEncoder().encode('PK a zip pretending'),
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: expect.stringContaining('wrong_mime') });
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'order',
        pageIndex: 0,
        bytes: pngBytes(640, 480).slice(0, 21),
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: expect.stringContaining('malformed_image') });
    expect(invocations.length).toBe(0);
  });

  it('a decode failure in the adapter is a refusal, and an adapter returning a non-image is too', async () => {
    const repo = new InMemoryCommerceImageArtifactRepository();
    installImageReencoder(() => Promise.reject(new Error('decoder crashed')));
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'catalog',
        pageIndex: 0,
        bytes: pngBytes(640, 480),
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: expect.stringContaining('decode failed') });

    installImageReencoder((bytes: Uint8Array, mime: CommerceImageMime) =>
      Promise.resolve({ bytes: new TextEncoder().encode('not an image'), mime }),
    );
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'catalog',
        pageIndex: 0,
        bytes: pngBytes(640, 480),
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: expect.stringContaining('reencode_invalid') });
  });

  it('refuses with no re-encoder installed', async () => {
    const repo = new InMemoryCommerceImageArtifactRepository();
    expect(
      await ingestCommerceImage({
        repository: repo,
        ownerDraftId: 'draft-1',
        lane: 'catalog',
        pageIndex: 0,
        bytes: pngBytes(640, 480),
        nowMs: T0,
      }),
    ).toMatchObject({ ok: false, refusal: expect.stringContaining('no_reencoder') });
  });
});

// ---------------------------------------------------------------------------
// The store, against real SQLite
// ---------------------------------------------------------------------------

describe('the SQLite artifact store', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let repo: CommerceImageArtifactRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'image-artifacts-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: bytesToHex(randomBytes(32)),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    repo = new SQLiteCommerceImageArtifactRepository(adapter);
  });
  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function ingestPage(draftId: string, pageIndex: number): Promise<string> {
    const result = await ingestCommerceImage({
      repository: repo,
      ownerDraftId: draftId,
      lane: 'catalog',
      pageIndex,
      bytes: pngBytes(640 + pageIndex, 480),
      nowMs: T0 + pageIndex,
    });
    if (!result.ok) throw new Error(result.refusal);
    return result.artifact.artifactId;
  }

  it('round-trips bytes, verified on read, and revalidates for egress', async () => {
    makeReencoder();
    const id = await ingestPage('draft-1', 0);
    const bytes = repo.getBytes(id);
    expect(bytes).not.toBeNull();
    const revalidated = revalidateStoredArtifact(repo, id);
    expect(revalidated.ok).toBe(true);

    // A blob edited after writing reads as ABSENT — and therefore refuses
    // egress rather than transmitting bytes nobody authorized.
    adapter.run(`UPDATE commerce_image_artifacts SET bytes = ? WHERE artifact_id = ?`, [
      new Uint8Array([9, 9, 9]),
      id,
    ]);
    expect(repo.getBytes(id)).toBeNull();
    expect(revalidateStoredArtifact(repo, id)).toMatchObject({ ok: false });
  });

  it('erasure removes every page of the draft and nothing else', async () => {
    makeReencoder();
    await ingestPage('draft-1', 0);
    await ingestPage('draft-1', 1);
    await ingestPage('draft-2', 0);

    repo.eraseDraft('draft-1');
    expect(repo.listByDraft('draft-1')).toEqual([]);
    expect(repo.listByDraft('draft-2').length).toBe(1);
  });

  it('the retention listing names drafts with their sizes', async () => {
    makeReencoder();
    await ingestPage('draft-1', 0);
    await ingestPage('draft-1', 1);
    await ingestPage('draft-2', 0);

    const retention = repo.listRetention();
    expect(retention.length).toBe(2);
    const first = retention.find((r) => r.draftId === 'draft-1');
    expect(first?.pages).toBe(2);
    expect(first?.bytes).toBeGreaterThan(0);
  });
});

describe('BLOB adapter parity — op-sqlite ArrayBuffer vs better-sqlite3 Buffer', () => {
  // getBytes only calls db.query; a minimal stub is enough to reproduce
  // each adapter's BLOB return shape.
  function repoReturning(bytes: unknown, contentHash: string): SQLiteCommerceImageArtifactRepository {
    const db = {
      query: () => [{ bytes, content_hash: contentHash }],
    } as unknown as ConstructorParameters<typeof SQLiteCommerceImageArtifactRepository>[0];
    return new SQLiteCommerceImageArtifactRepository(db);
  }

  it('coerces a bare ArrayBuffer (op-sqlite mobile) to a Uint8Array and validates', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = bytesToHex(sha256(payload));
    const asArrayBuffer = payload.buffer.slice(0); // op-sqlite hands back an ArrayBuffer
    const out = repoReturning(asArrayBuffer, hash).getBytes('a1');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes a Uint8Array/Buffer (better-sqlite3 server) through unchanged', () => {
    const payload = new Uint8Array([7, 8, 9]);
    const hash = bytesToHex(sha256(payload));
    expect(Array.from(repoReturning(payload, hash).getBytes('a1') ?? [])).toEqual([7, 8, 9]);
  });

  it('a non-buffer blob value reads as absent (refuses egress, no throw)', () => {
    expect(repoReturning({ not: 'bytes' }, 'deadbeef').getBytes('a1')).toBeNull();
  });
});
