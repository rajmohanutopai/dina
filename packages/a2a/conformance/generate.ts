/**
 * Writes conformance/vectors/directory_envelope.json — the frozen Lane 3
 * golden vectors (design §8.2, M0): the directory envelope, the fence, the
 * attempted-record digest, the RFC 8785 cases those contracts depend on, and
 * the refusals a verifier must produce, each with its expected reason. Signed
 * with a fixed Ed25519 key so another runtime (AppView, a port) can check its
 * bytes and its refusals against these.
 *
 * Nothing in the file is taken from Dina's code alone. The refusals' reasons
 * and the RFC 8785 cases are written by hand; every positive value (the card
 * texts and hashes, the envelope and fence signing texts and signatures, the
 * record digests) was derived by other code (`INDEPENDENT`, from
 * `derive_independent.py`). The generator recomputes each one with Dina's
 * functions and refuses to write the file if any disagrees.
 *
 * Ed25519 policy: RFC 8032 §5.1.7 verification with canonical encodings
 * (S < L; Dina verifiers use noble's `ed25519.verify(…, { zip215: false })`).
 *
 * Run: npx tsx packages/a2a/conformance/generate.ts
 * The test suite recomputes every value; regenerating must change nothing.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_CARD_COLLECTION,
  A2A_SELF_RKEY,
  attemptedRecordDigest,
  base64Decode,
  base64Encode,
  bytesToHex,
  canonicalize,
  cardStringHash,
  parseStrictJson,
  signDirectoryEnvelope,
  signFence,
  utf8Bytes,
  verifyDirectoryEnvelope,
  verifyFence,
  type EnvelopeContext,
} from '../src';

export const VECTOR_SECRET_KEY_HEX =
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const VECTOR_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
export const VECTOR_INSTANCE = '3f2b8c1e-7a4d-4b9e-9c1f-2d6e8a0b5c47';

export const VECTOR_CARD_TEXT = canonicalize({
  name: 'Bus 42 Desk',
  description: 'Next-bus times for route 42.',
  supportedInterfaces: [
    { url: 'https://a2a.example.org/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  version: '1',
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 'eta_query@self', name: 'ETA', description: 'Arrival time.', tags: ['transit'] }],
});

/**
 * A card whose text exercises the canonicalization splits between runtimes:
 * non-ASCII, an astral character, U+2028 (which some encoders escape), and
 * two keys whose UTF-16 order differs from their code-point order.
 */
export const VECTOR_UNICODE_CARD_TEXT = canonicalize({
  name: 'Bús 42 — 🚌',
  description: 'Línea 42 horarios',
  supportedInterfaces: [
    { url: 'https://a2a.example.org/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  version: '1',
  capabilities: {},
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 'eta_query@self', name: 'ETA', description: 'Hora.', tags: ['～', '😀'] }],
  '～': 'fullwidth tilde',
  '\u{1F600}': 'grinning face',
});

/**
 * Every positive value the file holds, derived by code that is not Dina's
 * (`derive_independent.py`: RFC 8785 by the a2a-sdk's canonicalizer, SHA-256
 * by hashlib, Ed25519 by the `cryptography` package). Rerun it and paste its
 * output here when an input changes. Non-ASCII is escaped, so no character
 * hides in the source.
 */
const INDEPENDENT = {
  public_key_hex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  card_text: "{\"capabilities\":{\"extendedAgentCard\":false,\"pushNotifications\":false,\"streaming\":false},\"defaultInputModes\":[\"application/json\"],\"defaultOutputModes\":[\"application/json\"],\"description\":\"Next-bus times for route 42.\",\"name\":\"Bus 42 Desk\",\"skills\":[{\"description\":\"Arrival time.\",\"id\":\"eta_query@self\",\"name\":\"ETA\",\"tags\":[\"transit\"]}],\"supportedInterfaces\":[{\"protocolBinding\":\"JSONRPC\",\"protocolVersion\":\"1.0\",\"url\":\"https://a2a.example.org/rpc\"}],\"version\":\"1\"}",
  card_hash: "c3c977cd93e4713ced3ba0a105c99a6406559cddf652e77f3ec2e518925b18cf",
  envelope_signing_text: "{\"card_hash\":\"c3c977cd93e4713ced3ba0a105c99a6406559cddf652e77f3ec2e518925b18cf\",\"collection\":\"com.dinakernel.a2a.card\",\"did\":\"did:plc:ewvi7nxzyoun6zhxrhs64oiz\",\"domain\":\"dina:a2a:directory-envelope:v1\",\"freshness_epoch\":3,\"publisher_epoch\":2,\"publisher_instance\":\"3f2b8c1e-7a4d-4b9e-9c1f-2d6e8a0b5c47\",\"rkey\":\"self\",\"v\":1}",
  envelope_sig: "luZUmLx0RBwN5EVB+yk/tTlPn3Jdu1AZTwla8WLZ7/e+GlN/K8A5Bv+nmcGklOr5XHpXQsNxA4t9Lxu9fx9VCg==",
  fence_signing_text: "{\"did\":\"did:plc:ewvi7nxzyoun6zhxrhs64oiz\",\"domain\":\"dina:a2a:fence:v1\",\"publisher_epoch\":2,\"publisher_instance\":\"3f2b8c1e-7a4d-4b9e-9c1f-2d6e8a0b5c47\",\"v\":1}",
  fence_sig: "VAza+XWyLIxEK8JWo3wyRInFkt3QmlTHR8l2wLlUhchq69RL5qg/HZpR1j6FKT6rOYXml2r8UlINKRfMgzNYBg==",
  record_digest: "3a07ff68078a2e23f4c0fcc70e86bd806df6a48c512f1ccdd8a0a232b64b4617",
  envelope_only_change_digest: "4290d88715c1e14c4d5bf14cf568f6426774141dcd163a4127d3c117a53dd468",
  sibling_change_digest: "a7a227200f9dc01404a9989fa3083769163f23c7b9dcf1302c6b7f32db59da67",
  unicode_card_text: "{\"capabilities\":{},\"defaultInputModes\":[\"application/json\"],\"defaultOutputModes\":[\"application/json\"],\"description\":\"L\u00ednea 42\u2028horarios\",\"name\":\"B\u00fas 42 \u2014 \ud83d\ude8c\",\"skills\":[{\"description\":\"Hora.\",\"id\":\"eta_query@self\",\"name\":\"ETA\",\"tags\":[\"\uff5e\",\"\ud83d\ude00\"]}],\"supportedInterfaces\":[{\"protocolBinding\":\"JSONRPC\",\"protocolVersion\":\"1.0\",\"url\":\"https://a2a.example.org/rpc\"}],\"version\":\"1\",\"\ud83d\ude00\":\"grinning face\",\"\uff5e\":\"fullwidth tilde\"}",
  unicode_card_text_utf8_hex: "7b226361706162696c6974696573223a7b7d2c2264656661756c74496e7075744d6f646573223a5b226170706c69636174696f6e2f6a736f6e225d2c2264656661756c744f75747075744d6f646573223a5b226170706c69636174696f6e2f6a736f6e225d2c226465736372697074696f6e223a224cc3ad6e6561203432e280a8686f726172696f73222c226e616d65223a2242c3ba7320343220e2809420f09f9a8c222c22736b696c6c73223a5b7b226465736372697074696f6e223a22486f72612e222c226964223a226574615f71756572794073656c66222c226e616d65223a22455441222c2274616773223a5b22efbd9e222c22f09f9880225d7d5d2c22737570706f72746564496e7465726661636573223a5b7b2270726f746f636f6c42696e64696e67223a224a534f4e525043222c2270726f746f636f6c56657273696f6e223a22312e30222c2275726c223a2268747470733a2f2f6132612e6578616d706c652e6f72672f727063227d5d2c2276657273696f6e223a2231222c22f09f9880223a226772696e6e696e672066616365222c22efbd9e223a2266756c6c77696474682074696c6465227d",
  unicode_card_hash: "d2d415d34cfffccd3fc7be06ba3637135842d40e7eab02799d11c87d805f4801",
  unicode_record_digest: "9938e00c88636553765a4db4d7c2b7b1687e65826f9d488573251682614b8c3f",
  signing_text_sha256: "02efeb9c92604a20a0e0a1df9f1a12124eb780e8e81096f392ee021f8d861e77",
} as const;

/** RFC 8785 cases, expected output written by hand. */
const JCS_CASES: { name: string; input: string; canonical: string }[] = [
  {
    name: 'non-ASCII, astral and U+2028 are written raw, not escaped',
    input: '{"b":"\\u00e9\\ud83d\\ude00\\u2028","a":1}',
    canonical: '{"a":1,"b":"é😀 "}',
  },
  {
    name: 'keys sort by UTF-16 code unit, so U+1F600 precedes U+FF5E',
    input: '{"\\uff5e":1,"\\ud83d\\ude00":2}',
    canonical: '{"😀":2,"～":1}',
  },
  {
    name: 'numbers in ECMAScript form',
    input: '[1e21,1e-7,-0,0.1,100,1.5e300,-1E+2]',
    canonical: '[1e+21,1e-7,0,0.1,100,1.5e+300,-100]',
  },
  {
    name: 'control characters escaped as JSON.stringify does; solidus left alone',
    input: '"\\u0001\\n\\t\\"\\\\\\/\\u001f"',
    canonical: '"\\u0001\\n\\t\\"\\\\/\\u001f"',
  },
  {
    name: 'nested members sorted at every level',
    input: '{"z":{"b":[{"d":1,"c":2}],"a":null},"y":true}',
    canonical: '{"y":true,"z":{"a":null,"b":[{"c":2,"d":1}]}}',
  },
];

/** Ed25519 group order L (RFC 8032 §5.1). */
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(bytes[i] ?? 0);
  return n;
}

function bigIntToLittleEndian(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The same signature with S replaced by S + L: equal mod L, but not canonical. */
function malleate(sigB64: string): string {
  const sig = base64Decode(sigB64);
  if (sig === null) throw new Error('malleate: bad signature');
  const s = littleEndianToBigInt(sig.slice(32)) + ED25519_L;
  if (s >= 1n << 256n) throw new Error('malleate: S + L does not fit in 32 bytes');
  const out = new Uint8Array(64);
  out.set(sig.slice(0, 32), 0);
  out.set(bigIntToLittleEndian(s, 32), 32);
  return base64Encode(out);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`vector generation: ${message}`);
}

async function main(): Promise<void> {
  const secret = Uint8Array.from(Buffer.from(VECTOR_SECRET_KEY_HEX, 'hex'));
  const sign = (msg: Uint8Array) => ed25519.sign(msg, secret);
  const publicKey = ed25519.getPublicKey(secret);
  const publicKeyHex = bytesToHex(publicKey);
  const verify = (msg: Uint8Array, sig: Uint8Array) =>
    ed25519.verify(sig, msg, publicKey, { zip215: false });
  const cardHash = cardStringHash(VECTOR_CARD_TEXT, sha256);

  const envelope = await signDirectoryEnvelope(
    {
      did: VECTOR_DID,
      collection: A2A_CARD_COLLECTION,
      rkey: A2A_SELF_RKEY,
      card_hash: cardHash,
      freshness_epoch: 3,
      publisher_epoch: 2,
      publisher_instance: VECTOR_INSTANCE,
    },
    sign,
  );
  const { sig: _envSig, ...envelopeUnsigned } = envelope;

  const fence = await signFence(
    { did: VECTOR_DID, publisher_epoch: 2, publisher_instance: VECTOR_INSTANCE },
    sign,
  );
  const { sig: _fenceSig, ...fenceUnsigned } = fence;

  const record = {
    $type: A2A_CARD_COLLECTION,
    card: VECTOR_CARD_TEXT,
    directory_envelope: envelope,
    endpoint: 'https://a2a.example.org/rpc',
    protocol_version: '1.0',
    // A record as the publisher writes it: every member the card lexicon requires.
    skills: ['eta_query@self'],
  };
  // Field order must not matter: the same record, members reversed.
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  const bumped = await signDirectoryEnvelope({ ...envelopeUnsigned, freshness_epoch: 4 }, sign);
  const envelopeOnlyChange = { ...record, directory_envelope: bumped };
  const siblingChange = { ...record, protocol_version: '1.1' };
  const unicodeRecord = { ...record, card: VECTOR_UNICODE_CARD_TEXT };

  const ctx: EnvelopeContext = {
    repoDid: VECTOR_DID,
    collection: A2A_CARD_COLLECTION,
    rkey: A2A_SELF_RKEY,
    cardText: VECTOR_CARD_TEXT,
  };

  // A signature over the same fields serialized in insertion order, not RFC 8785.
  const noncanonicalSig = base64Encode(await sign(utf8Bytes(JSON.stringify(envelopeUnsigned))));
  const fenceNoncanonicalSig = base64Encode(await sign(utf8Bytes(JSON.stringify(fenceUnsigned))));
  const replayedOther = await signDirectoryEnvelope(
    { ...envelopeUnsigned, did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' },
    sign,
  );

  const envelopeRefusals: {
    name: string;
    value: unknown;
    context?: Partial<EnvelopeContext>;
    expect: string;
  }[] = [
    {
      name: 'replayed into another repository',
      value: envelope,
      context: { repoDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' },
      expect: 'envelope_did_mismatch',
    },
    {
      name: 'signed for another repository',
      value: replayedOther,
      expect: 'envelope_did_mismatch',
    },
    {
      name: 'replayed onto another collection',
      value: envelope,
      context: { collection: 'com.dinakernel.a2a.fence' },
      expect: 'envelope_collection_mismatch',
    },
    {
      name: 'replayed onto another rkey',
      value: envelope,
      context: { rkey: 'other' },
      expect: 'envelope_rkey_mismatch',
    },
    {
      name: 'paired with a different card',
      value: envelope,
      context: { cardText: VECTOR_UNICODE_CARD_TEXT },
      expect: 'envelope_card_hash_mismatch',
    },
    {
      name: 'the fence domain',
      value: { ...envelope, domain: 'dina:a2a:fence:v1' },
      expect: 'envelope_domain',
    },
    { name: 'version 2', value: { ...envelope, v: 2 }, expect: 'envelope_version' },
    { name: 'an extra member', value: { ...envelope, extra: 1 }, expect: 'envelope_members' },
    {
      name: 'a fractional epoch',
      value: { ...envelope, freshness_epoch: 1.5 },
      expect: 'envelope_freshness_epoch',
    },
    {
      name: 'a negative epoch',
      value: { ...envelope, publisher_epoch: -1 },
      expect: 'envelope_publisher_epoch',
    },
    {
      name: 'an uppercase instance',
      value: { ...envelope, publisher_instance: VECTOR_INSTANCE.toUpperCase() },
      expect: 'envelope_publisher_instance',
    },
    {
      name: 'an unpadded signature',
      value: { ...envelope, sig: envelope.sig.replace(/=+$/, '') },
      expect: 'envelope_sig',
    },
    {
      name: 'a tampered epoch',
      value: { ...envelope, freshness_epoch: 4 },
      expect: 'envelope_signature',
    },
    {
      name: 'a signature over non-canonical bytes',
      value: { ...envelope, sig: noncanonicalSig },
      expect: 'envelope_signature',
    },
    {
      name: 'a malleated signature (S + L)',
      value: { ...envelope, sig: malleate(envelope.sig) },
      expect: 'envelope_signature',
    },
  ];

  const fenceRefusals: { name: string; value: unknown; repo_did?: string; expect: string }[] = [
    {
      name: 'read from another repository',
      value: fence,
      repo_did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      expect: 'fence_did_mismatch',
    },
    {
      name: 'the envelope domain',
      value: { ...fence, domain: 'dina:a2a:directory-envelope:v1' },
      expect: 'fence_domain',
    },
    {
      name: 'a fractional epoch',
      value: { ...fence, publisher_epoch: 2.5 },
      expect: 'fence_publisher_epoch',
    },
    {
      name: 'an epoch past 2^53',
      value: { ...fence, publisher_epoch: 2 ** 53 },
      expect: 'fence_publisher_epoch',
    },
    {
      name: 'a missing member',
      value: {
        v: fence.v,
        domain: fence.domain,
        did: fence.did,
        publisher_epoch: fence.publisher_epoch,
        sig: fence.sig,
      },
      expect: 'fence_members',
    },
    {
      name: 'a tampered epoch',
      value: { ...fence, publisher_epoch: 3 },
      expect: 'fence_signature',
    },
    {
      name: 'a signature over non-canonical bytes',
      value: { ...fence, sig: fenceNoncanonicalSig },
      expect: 'fence_signature',
    },
    {
      name: 'a malleated signature (S + L)',
      value: { ...fence, sig: malleate(fence.sig) },
      expect: 'fence_signature',
    },
  ];

  // Every hand-written expectation must hold, or nothing is written.
  check(verifyDirectoryEnvelope(envelope, ctx, sha256, verify).ok, 'valid envelope verifies');
  check(verifyFence(fence, VECTOR_DID, verify).ok, 'valid fence verifies');
  for (const r of envelopeRefusals) {
    const got = verifyDirectoryEnvelope(r.value, { ...ctx, ...r.context }, sha256, verify);
    check(!got.ok && got.reason === r.expect, `envelope "${r.name}" → ${JSON.stringify(got)}`);
  }
  for (const r of fenceRefusals) {
    const got = verifyFence(r.value, r.repo_did ?? VECTOR_DID, verify);
    check(!got.ok && got.reason === r.expect, `fence "${r.name}" → ${JSON.stringify(got)}`);
  }
  for (const c of JCS_CASES) {
    const parsed = parseStrictJson(c.input);
    check(parsed.ok && canonicalize(parsed.value) === c.canonical, `jcs "${c.name}"`);
  }
  const computed: Record<keyof typeof INDEPENDENT, string> = {
    public_key_hex: publicKeyHex,
    card_text: VECTOR_CARD_TEXT,
    card_hash: cardHash,
    envelope_signing_text: canonicalize(envelopeUnsigned),
    envelope_sig: envelope.sig,
    fence_signing_text: canonicalize(fenceUnsigned),
    fence_sig: fence.sig,
    record_digest: attemptedRecordDigest(record, sha256),
    envelope_only_change_digest: attemptedRecordDigest(envelopeOnlyChange, sha256),
    sibling_change_digest: attemptedRecordDigest(siblingChange, sha256),
    unicode_card_text: VECTOR_UNICODE_CARD_TEXT,
    unicode_card_text_utf8_hex: bytesToHex(utf8Bytes(VECTOR_UNICODE_CARD_TEXT)),
    unicode_card_hash: cardStringHash(VECTOR_UNICODE_CARD_TEXT, sha256),
    unicode_record_digest: attemptedRecordDigest(unicodeRecord, sha256),
    signing_text_sha256: bytesToHex(sha256(utf8Bytes(canonicalize(envelopeUnsigned)))),
  };
  for (const [name, value] of Object.entries(INDEPENDENT)) {
    check(computed[name as keyof typeof INDEPENDENT] === value, `${name} differs from its independent derivation`);
  }
  check(attemptedRecordDigest(reordered, sha256) === INDEPENDENT.record_digest, 'member order changes the digest');

  const vectors = {
    description:
      'A2A Lane 3 golden vectors (design §8.2): Ed25519 over RFC 8785 of every field except sig; sig is padded base64. Verification is RFC 8032 §5.1.7 with canonical encodings (S < L).',
    public_key_hex: publicKeyHex,
    card_text: VECTOR_CARD_TEXT,
    card_hash: cardHash,
    envelope: {
      value: envelope,
      signing_text: canonicalize(envelopeUnsigned),
    },
    fence: {
      value: fence,
      signing_text: canonicalize(fenceUnsigned),
    },
    attempted_record_digest: {
      record,
      digest: attemptedRecordDigest(record, sha256),
      reordered_digest: attemptedRecordDigest(reordered, sha256),
      envelope_only_change_digest: attemptedRecordDigest(envelopeOnlyChange, sha256),
      sibling_change_digest: attemptedRecordDigest(siblingChange, sha256),
    },
    unicode_card: {
      card_text: VECTOR_UNICODE_CARD_TEXT,
      card_text_utf8_hex: bytesToHex(utf8Bytes(VECTOR_UNICODE_CARD_TEXT)),
      card_hash: cardStringHash(VECTOR_UNICODE_CARD_TEXT, sha256),
      record_digest: attemptedRecordDigest(unicodeRecord, sha256),
    },
    jcs: JCS_CASES.map((c) => ({ ...c, canonical_utf8_hex: bytesToHex(utf8Bytes(c.canonical)) })),
    envelope_refusals: envelopeRefusals,
    fence_refusals: fenceRefusals,
    signing_text_sha256: bytesToHex(sha256(utf8Bytes(canonicalize(envelopeUnsigned)))),
  };
  writeFileSync(
    join(__dirname, 'vectors', 'directory_envelope.json'),
    `${JSON.stringify(vectors, null, 2)}\n`,
  );
}

void main();
