import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_CARD_COLLECTION,
  A2A_SELF_RKEY,
  attemptedRecordDigest,
  base64Encode,
  bytesToHex,
  canonicalize,
  parseStrictJson,
  utf8Bytes,
  cardStringHash,
  signDirectoryEnvelope,
  signFence,
  validateDirectoryEnvelope,
  validateFence,
  verifyDirectoryEnvelope,
  verifyFence,
  type DirectoryEnvelope,
  type EnvelopeContext,
  type Fence,
} from '../src';

interface Vectors {
  public_key_hex: string;
  card_text: string;
  card_hash: string;
  envelope: { value: DirectoryEnvelope; signing_text: string };
  fence: { value: Fence; signing_text: string };
  attempted_record_digest: {
    record: Record<string, unknown>;
    digest: string;
    reordered_digest: string;
    envelope_only_change_digest: string;
    sibling_change_digest: string;
  };
  unicode_card: {
    card_text: string;
    card_text_utf8_hex: string;
    card_hash: string;
    record_digest: string;
  };
  jcs: { name: string; input: string; canonical: string; canonical_utf8_hex: string }[];
  envelope_refusals: {
    name: string;
    value: unknown;
    context?: Partial<EnvelopeContext>;
    expect: string;
  }[];
  fence_refusals: { name: string; value: unknown; repo_did?: string; expect: string }[];
}

const V = JSON.parse(
  readFileSync(join(__dirname, '..', 'conformance', 'vectors', 'directory_envelope.json'), 'utf8'),
) as Vectors;

const SECRET = Uint8Array.from(
  Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
);
const PUBLIC = Uint8Array.from(Buffer.from(V.public_key_hex, 'hex'));
const verifyEd = (msg: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, msg, PUBLIC);
const sign = (msg: Uint8Array) => ed25519.sign(msg, SECRET);

const ctx = {
  repoDid: V.envelope.value.did,
  collection: A2A_CARD_COLLECTION,
  rkey: A2A_SELF_RKEY,
  cardText: V.card_text,
};

describe('golden vectors: directory envelope', () => {
  it('hashes the exact card string bytes', () => {
    expect(cardStringHash(V.card_text, sha256)).toBe(V.card_hash);
  });

  it('reproduces the frozen envelope byte for byte', async () => {
    const { v: _v, domain: _d, sig: _s, ...fields } = V.envelope.value;
    const regenerated = await signDirectoryEnvelope(fields, sign);
    expect(regenerated).toEqual(V.envelope.value);
    const { sig: _sig, ...unsigned } = regenerated;
    expect(canonicalize(unsigned)).toBe(V.envelope.signing_text);
  });

  it('verifies against the record it arrived in', () => {
    expect(verifyDirectoryEnvelope(V.envelope.value, ctx, sha256, verifyEd)).toEqual({ ok: true });
  });

  it.each([
    [
      'another repository (replay across DIDs)',
      { repoDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' },
      'envelope_did_mismatch',
    ],
    [
      'another collection (cross-record replay)',
      { collection: 'com.dinakernel.a2a.fence' },
      'envelope_collection_mismatch',
    ],
    ['another rkey', { rkey: 'other' }, 'envelope_rkey_mismatch'],
    ['a different card', { cardText: `${V.card_text} ` }, 'envelope_card_hash_mismatch'],
  ])('refuses %s', (_name, over, reason) => {
    expect(
      verifyDirectoryEnvelope(V.envelope.value, { ...ctx, ...over }, sha256, verifyEd),
    ).toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses a signature by another key', () => {
    const other = ed25519.utils.randomSecretKey();
    const verifyOther = (msg: Uint8Array, sig: Uint8Array) =>
      ed25519.verify(sig, msg, ed25519.getPublicKey(other));
    expect(verifyDirectoryEnvelope(V.envelope.value, ctx, sha256, verifyOther)).toEqual({
      ok: false,
      reason: 'envelope_signature',
    });
  });

  it('refuses a tampered epoch even though the shape is fine', () => {
    const tampered = { ...V.envelope.value, freshness_epoch: 4 };
    expect(verifyDirectoryEnvelope(tampered, ctx, sha256, verifyEd)).toEqual({
      ok: false,
      reason: 'envelope_signature',
    });
  });

  it.each([
    ['wrong domain', { domain: 'dina:a2a:fence:v1' }, 'domain'],
    ['version 2', { v: 2 }, 'version'],
    ['a negative epoch', { publisher_epoch: -1 }, 'publisher_epoch'],
    ['a fractional epoch', { freshness_epoch: 1.5 }, 'freshness_epoch'],
    ['an unsafe epoch', { freshness_epoch: 2 ** 53 }, 'freshness_epoch'],
    ['an uppercase card hash', { card_hash: V.card_hash.toUpperCase() }, 'card_hash'],
    ['a non-UUID instance', { publisher_instance: 'instance-1' }, 'publisher_instance'],
    [
      'an uppercase UUID',
      { publisher_instance: V.envelope.value.publisher_instance.toUpperCase() },
      'publisher_instance',
    ],
    ['an unpadded signature', { sig: V.envelope.value.sig.replace(/=+$/, '') }, 'sig'],
    [
      'a url-alphabet signature',
      { sig: base64Encode(new Uint8Array(64).fill(251)).replace(/\+/g, '-') },
      'sig',
    ],
    ['a short signature', { sig: base64Encode(new Uint8Array(63)) }, 'sig'],
    ['a bad DID', { did: 'did:example:x' }, 'did'],
  ])('shape check refuses %s', (_name, over, reason) => {
    expect(validateDirectoryEnvelope({ ...V.envelope.value, ...over })).toBe(reason);
  });

  it('refuses extra or missing members', () => {
    expect(validateDirectoryEnvelope({ ...V.envelope.value, extra: 1 })).toBe('members');
    const { publisher_instance: _p, ...missing } = V.envelope.value;
    expect(validateDirectoryEnvelope(missing)).toBe('members');
  });

  it('will not sign a malformed envelope', async () => {
    const { v: _v, domain: _d, sig: _s, ...fields } = V.envelope.value;
    await expect(signDirectoryEnvelope({ ...fields, publisher_epoch: -1 }, sign)).rejects.toThrow(
      /publisher_epoch/,
    );
  });
});

describe('golden vectors: fence', () => {
  it('reproduces the frozen fence byte for byte', async () => {
    const { v: _v, domain: _d, sig: _s, ...fields } = V.fence.value;
    expect(await signFence(fields, sign)).toEqual(V.fence.value);
    const { sig: _sig, ...unsigned } = V.fence.value;
    expect(canonicalize(unsigned)).toBe(V.fence.signing_text);
  });

  it('verifies when read from its own repository', () => {
    expect(verifyFence(V.fence.value, V.fence.value.did, verifyEd)).toEqual({ ok: true });
  });

  it('refuses a fence read from another repository (signed for another DID)', () => {
    expect(verifyFence(V.fence.value, 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', verifyEd)).toEqual({
      ok: false,
      reason: 'fence_did_mismatch',
    });
  });

  it('refuses an envelope presented as a fence (domain separation)', () => {
    expect(validateFence(V.envelope.value)).toBe('members');
    expect(validateFence({ ...V.fence.value, domain: 'dina:a2a:directory-envelope:v1' })).toBe(
      'domain',
    );
  });

  it('refuses a replayed fence with a raised epoch', () => {
    expect(
      verifyFence({ ...V.fence.value, publisher_epoch: 9 }, V.fence.value.did, verifyEd),
    ).toEqual({
      ok: false,
      reason: 'fence_signature',
    });
  });

  it('treats a verifier that throws as a failed signature', () => {
    const throwing = () => {
      throw new Error('bad point');
    };
    expect(verifyFence(V.fence.value, V.fence.value.did, throwing)).toEqual({
      ok: false,
      reason: 'fence_signature',
    });
  });
});

describe('golden vectors: attempted-record digest', () => {
  const D = V.attempted_record_digest;

  it('reproduces the frozen digest', () => {
    expect(attemptedRecordDigest(D.record as never, sha256)).toBe(D.digest);
  });

  it('ignores member order (a fetched record canonicalizes the same)', () => {
    expect(D.reordered_digest).toBe(D.digest);
    const reversed = Object.fromEntries(Object.entries(D.record).reverse());
    expect(attemptedRecordDigest(reversed as never, sha256)).toBe(D.digest);
  });

  it('changes with an envelope-only cadence bump and with a sibling change', () => {
    expect(D.envelope_only_change_digest).not.toBe(D.digest);
    expect(D.sibling_change_digest).not.toBe(D.digest);
    expect(D.sibling_change_digest).not.toBe(D.envelope_only_change_digest);
  });

  it('distinguishes two different records from the same instance', () => {
    const a = attemptedRecordDigest({ ...D.record, endpoint: 'https://a' } as never, sha256);
    const b = attemptedRecordDigest({ ...D.record, endpoint: 'https://b' } as never, sha256);
    expect(a).not.toBe(b);
  });
});

describe('golden vectors: frozen refusals and canonical forms (another runtime replays these)', () => {
  // RFC 8032 strict verification, the policy the vector file states.
  const strictVerify = (msg: Uint8Array, sig: Uint8Array) =>
    ed25519.verify(sig, msg, PUBLIC, { zip215: false });

  it.each(V.envelope_refusals.map((r) => [r.name, r] as const))('envelope: %s', (_name, r) => {
    expect(
      verifyDirectoryEnvelope(r.value, { ...ctx, ...r.context }, sha256, strictVerify),
    ).toEqual({
      ok: false,
      reason: r.expect,
    });
  });

  it.each(V.fence_refusals.map((r) => [r.name, r] as const))('fence: %s', (_name, r) => {
    expect(verifyFence(r.value, r.repo_did ?? V.fence.value.did, strictVerify)).toEqual({
      ok: false,
      reason: r.expect,
    });
  });

  it.each(V.jcs.map((c) => [c.name, c] as const))('jcs: %s', (_name, c) => {
    const parsed = parseStrictJson(c.input);
    if (!parsed.ok) throw new Error(parsed.reason);
    const out = canonicalize(parsed.value);
    expect(out).toBe(c.canonical);
    expect(bytesToHex(utf8Bytes(out))).toBe(c.canonical_utf8_hex);
  });

  it('hashes and digests a card with non-ASCII, astral and U+2028 text byte for byte', () => {
    const u = V.unicode_card;
    expect(bytesToHex(utf8Bytes(u.card_text))).toBe(u.card_text_utf8_hex);
    expect(cardStringHash(u.card_text, sha256)).toBe(u.card_hash);
    const record = { ...V.attempted_record_digest.record, card: u.card_text };
    expect(attemptedRecordDigest(record as never, sha256)).toBe(u.record_digest);
  });
});

// Cold audit C4-1: the digest vector is a record the directory would take
it('the attempted-record vector is a whole card record: every member the card lexicon requires, and no other', () => {
  const lexicon = JSON.parse(
    readFileSync(join(__dirname, '..', 'lexicons', 'com', 'dinakernel', 'a2a', 'card.json'), 'utf8'),
  ) as { defs: { main: { record: { required: string[]; properties: Record<string, unknown> } } } };
  const { required, properties } = lexicon.defs.main.record;
  const members = Object.keys(V.attempted_record_digest.record).filter((k) => k !== '$type');
  expect(required.filter((k) => !members.includes(k))).toEqual([]);
  expect(members.filter((k) => !Object.prototype.hasOwnProperty.call(properties, k))).toEqual([]);
});

it('the fence vectors hold a signature over non-canonical bytes, refused as the envelope’s is', () => {
  expect(V.fence_refusals.find((r) => r.name === 'a signature over non-canonical bytes')?.expect).toBe('fence_signature');
});
