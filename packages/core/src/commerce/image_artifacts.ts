/**
 * The photograph, as a defined artifact (PHOTO_COMMERCE_LANES_DESIGN §6).
 *
 * BOUNDS ARE ENFORCED AT THIS TRUSTED INGEST BOUNDARY, not at capture. A
 * capture-side limit is a client convention, and an alternate client
 * holding the owner capability walks straight past it. Ingest enforces
 * page count, per-page and aggregate byte ceilings, a MIME allowlist, and
 * a TWO-PHASE decode:
 *
 *   Phase 1 — a bounded HEADER PARSE, in this compiled kernel code, that
 *   reads the declared dimensions and refuses anything over the caps
 *   WITHOUT decoding. A decompression bomb is a small file declaring an
 *   enormous image; a byte ceiling alone admits it to exhaust memory
 *   during the decode. The named test proves rejection happens without
 *   the declared allocation ever existing.
 *
 *   Phase 2 — the full decode + re-encode, which strips EXIF (location,
 *   capture time, device identity are disclosures the seller never saw on
 *   screen) and disarms structural decoder attacks. Decoding is platform
 *   work, so it is an INJECTED adapter — sharp on the server, the image
 *   manipulator on the phone — and Core re-validates the re-encoded bytes
 *   against the same caps before storing anything, because an adapter is
 *   not this module's trust boundary.
 *
 * The stored artifact's content_hash is over the STRIPPED bytes; it is
 * what the extraction manifest commits to and what egress authorizations
 * pin. Original camera bytes never persist.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { MAX_EXTRACTION_PAGES } from '@dina/commerce-protocol';

import type { DatabaseAdapter } from '../storage/db_adapter';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard per-draft aggregate — §6's default, and it is a hard limit. */
export const MAX_AGGREGATE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PAGE_IMAGE_BYTES = 4 * 1024 * 1024;
/** One page count for capture, manifest and store: the protocol's bound. */
export const MAX_IMAGE_PAGES = MAX_EXTRACTION_PAGES;
export const MAX_IMAGE_DIMENSION = 8192;
/**
 * Projected decoded allocation cap: pixels × 4 (RGBA). 20 MP decodes to
 * ~80 MB, which a phone survives; a bomb declaring 50000×50000 projects
 * 10 GB and dies here, undecoded.
 */
export const MAX_IMAGE_PIXELS = 20_000_000;

export const IMAGE_MIME_ALLOWLIST = ['image/jpeg', 'image/png'] as const;
export type CommerceImageMime = (typeof IMAGE_MIME_ALLOWLIST)[number];

// ---------------------------------------------------------------------------
// Phase 1 — bounded header parse (pure, no allocation beyond the scan)
// ---------------------------------------------------------------------------

export type ParsedImageHeader =
  | { ok: true; mime: CommerceImageMime; width: number; height: number }
  | { ok: false; refusal: string };

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

function parsePng(bytes: Uint8Array): ParsedImageHeader {
  // Signature, then IHDR must be the first chunk (the spec requires it).
  if (bytes.length < 33) return { ok: false, refusal: 'malformed_image: truncated PNG' };
  if (u32be(bytes, 12) !== 0x49484452) {
    return { ok: false, refusal: 'malformed_image: PNG missing IHDR' };
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width === 0 || height === 0) {
    return { ok: false, refusal: 'malformed_image: zero dimension' };
  }
  // Chunk walk BY DECLARED LENGTHS — a table scan, never a decode — to
  // refuse animated PNG: frame count is one of the declared-allocation
  // inputs, and the allowlist admits still photographs only.
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32be(bytes, at);
    const type = u32be(bytes, at + 4);
    if (type === 0x6163544c /* acTL */) {
      return { ok: false, refusal: 'malformed_image: animated PNG is not a photograph' };
    }
    if (type === 0x49444154 /* IDAT — headers precede data; stop scanning */) break;
    if (length > bytes.length) return { ok: false, refusal: 'malformed_image: chunk overruns file' };
    at += 12 + length;
  }
  return { ok: true, mime: 'image/png', width, height };
}

function parseJpeg(bytes: Uint8Array): ParsedImageHeader {
  // Walk segments by declared length to a start-of-frame marker. Bounded by
  // the file size; nothing is decompressed.
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return { ok: false, refusal: 'malformed_image: JPEG marker desync' };
    const marker = bytes[at + 1] ?? 0;
    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    if (length < 2) return { ok: false, refusal: 'malformed_image: JPEG segment length' };
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (at + 9 > bytes.length) return { ok: false, refusal: 'malformed_image: truncated SOF' };
      const height = u16be(bytes, at + 5);
      const width = u16be(bytes, at + 7);
      if (width === 0 || height === 0) {
        return { ok: false, refusal: 'malformed_image: zero dimension' };
      }
      return { ok: true, mime: 'image/jpeg', width, height };
    }
    if (marker === 0xda /* start of scan — no SOF seen first */) break;
    at += 2 + length;
  }
  return { ok: false, refusal: 'malformed_image: no JPEG frame header' };
}

/**
 * Sniff and parse the header, refusing over-cap declarations undecoded.
 * The MIME is taken from the BYTES, never from a caller's claim — a caller
 * naming image/png around a zip file is precisely the case.
 */
export function parseImageHeader(bytes: Uint8Array): ParsedImageHeader {
  if (bytes.length >= 8 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) {
    return checkCaps(parsePng(bytes));
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return checkCaps(parseJpeg(bytes));
  }
  return { ok: false, refusal: 'wrong_mime: not a JPEG or PNG photograph' };
}

function checkCaps(parsed: ParsedImageHeader): ParsedImageHeader {
  if (!parsed.ok) return parsed;
  if (parsed.width > MAX_IMAGE_DIMENSION || parsed.height > MAX_IMAGE_DIMENSION) {
    return { ok: false, refusal: 'decompression_bomb: declared dimension over cap' };
  }
  if (parsed.width * parsed.height > MAX_IMAGE_PIXELS) {
    return { ok: false, refusal: 'decompression_bomb: projected decoded allocation over cap' };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Phase 2 — the injected re-encoder
// ---------------------------------------------------------------------------

/**
 * Decode fully and re-encode with ALL metadata dropped. Platform work,
 * injected by the composition root; a throwing re-encoder is a refusal.
 * Core re-validates the result — the adapter is not the trust boundary.
 */
export type ImageReencoder = (
  bytes: Uint8Array,
  mime: CommerceImageMime,
) => Promise<{ bytes: Uint8Array; mime: CommerceImageMime }>;

let reencoder: ImageReencoder | null = null;

export function installImageReencoder(value: ImageReencoder | null): void {
  reencoder = value;
}

export function imageReencoderInstalled(): boolean {
  return reencoder !== null;
}

// ---------------------------------------------------------------------------
// The artifact and its store
// ---------------------------------------------------------------------------

export type CommerceImageLane = 'catalog' | 'order';

export interface CommerceImageArtifact {
  artifactId: string;
  ownerDraftId: string;
  lane: CommerceImageLane;
  pageIndex: number;
  mime: CommerceImageMime;
  byteLength: number;
  /** sha-256 over the STORED (stripped, re-encoded) bytes. */
  contentHash: string;
  createdAtMs: number;
}

export interface CommerceImageArtifactRepository {
  put(artifact: CommerceImageArtifact, bytes: Uint8Array): void;
  getMeta(artifactId: string): CommerceImageArtifact | null;
  /** The stored bytes, or null — verified against the stored hash on read. */
  getBytes(artifactId: string): Uint8Array | null;
  listByDraft(draftId: string): CommerceImageArtifact[];
  /** Total stored bytes for a draft — the aggregate-ceiling input. */
  draftBytes(draftId: string): number;
  /** Transactional: every page of the draft goes together. */
  eraseDraft(draftId: string): void;
  /** §6's retention listing: drafts with their page counts and sizes. */
  listRetention(): { draftId: string; lane: CommerceImageLane; pages: number; bytes: number }[];
}

export function newImageArtifactId(): string {
  return `img_${bytesToHex(randomBytes(16))}`;
}

export type ImageIngest =
  | { ok: true; artifact: CommerceImageArtifact }
  | { ok: false; refusal: string };

/**
 * The ingest boundary. Takes candidate bytes, returns a stored artifact or
 * a refusal — and refuses BEFORE decoding wherever refusal is possible.
 */
export async function ingestCommerceImage(args: {
  repository: CommerceImageArtifactRepository;
  ownerDraftId: string;
  lane: CommerceImageLane;
  pageIndex: number;
  bytes: Uint8Array;
  nowMs: number;
}): Promise<ImageIngest> {
  const installed = reencoder;
  if (installed === null) {
    return { ok: false, refusal: 'no_reencoder: this node cannot ingest photographs' };
  }
  if (args.pageIndex < 0 || args.pageIndex >= MAX_IMAGE_PAGES) {
    return { ok: false, refusal: 'too_many_pages' };
  }
  if (args.repository.listByDraft(args.ownerDraftId).length >= MAX_IMAGE_PAGES) {
    return { ok: false, refusal: 'too_many_pages' };
  }
  if (args.bytes.byteLength === 0) {
    return { ok: false, refusal: 'malformed_image: empty' };
  }
  if (args.bytes.byteLength > MAX_PAGE_IMAGE_BYTES) {
    return { ok: false, refusal: 'oversize_page' };
  }
  if (args.repository.draftBytes(args.ownerDraftId) + args.bytes.byteLength > MAX_AGGREGATE_IMAGE_BYTES) {
    return { ok: false, refusal: 'oversize_draft_aggregate' };
  }

  // Phase 1: header caps, undecoded.
  const header = parseImageHeader(args.bytes);
  if (!header.ok) return header;

  // Phase 2: decode + strip + re-encode, then RE-VALIDATE the result.
  let stripped: { bytes: Uint8Array; mime: CommerceImageMime };
  try {
    stripped = await installed(args.bytes, header.mime);
  } catch {
    return { ok: false, refusal: 'malformed_image: decode failed' };
  }
  const restated = parseImageHeader(stripped.bytes);
  if (!restated.ok) return { ok: false, refusal: 'reencode_invalid: adapter returned a non-image' };
  if (stripped.bytes.byteLength > MAX_PAGE_IMAGE_BYTES) {
    return { ok: false, refusal: 'oversize_page' };
  }

  const artifact: CommerceImageArtifact = {
    artifactId: newImageArtifactId(),
    ownerDraftId: args.ownerDraftId,
    lane: args.lane,
    pageIndex: args.pageIndex,
    mime: restated.mime,
    byteLength: stripped.bytes.byteLength,
    contentHash: bytesToHex(sha256(stripped.bytes)),
    createdAtMs: args.nowMs,
  };
  args.repository.put(artifact, stripped.bytes);
  return { ok: true, artifact };
}

/**
 * §6: "the stored artifact is revalidated against these bounds before any
 * egress authorization is issued." The mint path calls this per page.
 */
export function revalidateStoredArtifact(
  repository: CommerceImageArtifactRepository,
  artifactId: string,
): { ok: true; contentHash: string } | { ok: false; refusal: string } {
  const meta = repository.getMeta(artifactId);
  if (meta === null) return { ok: false, refusal: 'unknown_artifact' };
  const bytes = repository.getBytes(artifactId);
  if (bytes === null) return { ok: false, refusal: 'artifact_unreadable' };
  if (bytes.byteLength > MAX_PAGE_IMAGE_BYTES) return { ok: false, refusal: 'oversize_page' };
  const header = parseImageHeader(bytes);
  if (!header.ok) return header;
  return { ok: true, contentHash: bytesToHex(sha256(bytes)) };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

interface ArtifactRow {
  [column: string]: string | number | Uint8Array | null;
  artifact_id: string;
  owner_draft_id: string;
  lane: string;
  page_index: number;
  mime: string;
  byte_length: number;
  content_hash: string;
  created_at_ms: number;
}

function metaFromRow(row: ArtifactRow): CommerceImageArtifact | null {
  const lane = String(row.lane);
  const mime = String(row.mime);
  if (lane !== 'catalog' && lane !== 'order') return null;
  if (!(IMAGE_MIME_ALLOWLIST as readonly string[]).includes(mime)) return null;
  if (!HEX64.test(String(row.content_hash))) return null;
  return {
    artifactId: String(row.artifact_id),
    ownerDraftId: String(row.owner_draft_id),
    lane,
    pageIndex: Number(row.page_index),
    mime: mime as CommerceImageMime,
    byteLength: Number(row.byte_length),
    contentHash: String(row.content_hash),
    createdAtMs: Number(row.created_at_ms),
  };
}

export class SQLiteCommerceImageArtifactRepository implements CommerceImageArtifactRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(artifact: CommerceImageArtifact, bytes: Uint8Array): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_image_artifacts
         (artifact_id, owner_draft_id, lane, page_index, mime, byte_length,
          content_hash, bytes, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.artifactId,
        artifact.ownerDraftId,
        artifact.lane,
        artifact.pageIndex,
        artifact.mime,
        artifact.byteLength,
        artifact.contentHash,
        bytes,
        artifact.createdAtMs,
      ],
    );
  }

  getMeta(artifactId: string): CommerceImageArtifact | null {
    const rows = this.db.query<ArtifactRow>(
      `SELECT artifact_id, owner_draft_id, lane, page_index, mime, byte_length,
              content_hash, created_at_ms
         FROM commerce_image_artifacts WHERE artifact_id = ?`,
      [artifactId],
    );
    return rows[0] === undefined ? null : metaFromRow(rows[0]);
  }

  getBytes(artifactId: string): Uint8Array | null {
    const rows = this.db.query<{ bytes: Uint8Array; content_hash: string }>(
      `SELECT bytes, content_hash FROM commerce_image_artifacts WHERE artifact_id = ?`,
      [artifactId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const bytes = row.bytes;
    // VERIFIED ON READ, the same discipline as every store here: a blob
    // edited after writing reads as absent, and an absent page refuses
    // egress rather than transmitting bytes nobody authorized.
    if (bytesToHex(sha256(bytes)) !== String(row.content_hash)) return null;
    return bytes;
  }

  listByDraft(draftId: string): CommerceImageArtifact[] {
    const rows = this.db.query<ArtifactRow>(
      `SELECT artifact_id, owner_draft_id, lane, page_index, mime, byte_length,
              content_hash, created_at_ms
         FROM commerce_image_artifacts WHERE owner_draft_id = ? ORDER BY page_index ASC`,
      [draftId],
    );
    return rows.map(metaFromRow).filter((a): a is CommerceImageArtifact => a !== null);
  }

  draftBytes(draftId: string): number {
    const rows = this.db.query<{ total: number | null }>(
      `SELECT SUM(byte_length) AS total FROM commerce_image_artifacts WHERE owner_draft_id = ?`,
      [draftId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  eraseDraft(draftId: string): void {
    this.db.run(`DELETE FROM commerce_image_artifacts WHERE owner_draft_id = ?`, [draftId]);
  }

  listRetention(): { draftId: string; lane: CommerceImageLane; pages: number; bytes: number }[] {
    const rows = this.db.query<{
      owner_draft_id: string;
      lane: string;
      pages: number;
      total: number;
    }>(
      `SELECT owner_draft_id, lane, COUNT(*) AS pages, SUM(byte_length) AS total
         FROM commerce_image_artifacts GROUP BY owner_draft_id, lane
         ORDER BY total DESC`,
    );
    return rows
      .filter((r) => r.lane === 'catalog' || r.lane === 'order')
      .map((r) => ({
        draftId: String(r.owner_draft_id),
        lane: r.lane as CommerceImageLane,
        pages: Number(r.pages),
        bytes: Number(r.total),
      }));
  }
}

export class InMemoryCommerceImageArtifactRepository implements CommerceImageArtifactRepository {
  private readonly rows = new Map<string, { meta: CommerceImageArtifact; bytes: Uint8Array }>();

  put(artifact: CommerceImageArtifact, bytes: Uint8Array): void {
    this.rows.set(artifact.artifactId, { meta: { ...artifact }, bytes: bytes.slice() });
  }

  getMeta(artifactId: string): CommerceImageArtifact | null {
    const row = this.rows.get(artifactId);
    return row === undefined ? null : { ...row.meta };
  }

  getBytes(artifactId: string): Uint8Array | null {
    const row = this.rows.get(artifactId);
    if (row === undefined) return null;
    if (bytesToHex(sha256(row.bytes)) !== row.meta.contentHash) return null;
    return row.bytes.slice();
  }

  listByDraft(draftId: string): CommerceImageArtifact[] {
    return [...this.rows.values()]
      .filter((r) => r.meta.ownerDraftId === draftId)
      .sort((a, b) => a.meta.pageIndex - b.meta.pageIndex)
      .map((r) => ({ ...r.meta }));
  }

  draftBytes(draftId: string): number {
    return this.listByDraft(draftId).reduce((sum, a) => sum + a.byteLength, 0);
  }

  eraseDraft(draftId: string): void {
    for (const [id, row] of this.rows) {
      if (row.meta.ownerDraftId === draftId) this.rows.delete(id);
    }
  }

  listRetention(): { draftId: string; lane: CommerceImageLane; pages: number; bytes: number }[] {
    const grouped = new Map<string, { lane: CommerceImageLane; pages: number; bytes: number }>();
    for (const { meta } of this.rows.values()) {
      const entry = grouped.get(meta.ownerDraftId) ?? { lane: meta.lane, pages: 0, bytes: 0 };
      entry.pages += 1;
      entry.bytes += meta.byteLength;
      grouped.set(meta.ownerDraftId, entry);
    }
    return [...grouped.entries()]
      .map(([draftId, entry]) => ({ draftId, ...entry }))
      .sort((a, b) => b.bytes - a.bytes);
  }
}
