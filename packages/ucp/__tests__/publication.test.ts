import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  documentHash,
  dropBoxWebhookUrl,
  labelForHostname,
  labelFromBytes,
  LABEL_PATTERN,
  profileUrlForLabel,
  signPublication,
  validatePublication,
  verifyPublication,
  type PublicationFields,
} from '../src/publication';

const secret = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(secret);
const sign = (m: Uint8Array) => ed25519.sign(m, secret);
const verify = (m: Uint8Array, s: Uint8Array) => ed25519.verify(s, m, publicKey);

const LABEL = labelFromBytes(new Uint8Array(16).fill(0xab));
const PROFILE = '{"keys":[],"ucp":{"version":"2026-08-25"}}';
const THUMB = 'A'.repeat(43);

const upload = (over: Partial<PublicationFields> = {}): PublicationFields => ({
  op: 'upload',
  did: 'did:plc:abcdefghijklmnopqrstuvwx',
  label: LABEL,
  epoch: 1,
  instance: '0b1f6c3e-2a4d-4e5f-8a9b-0c1d2e3f4a5b',
  revision: 1,
  issued_at: 1_759_000_000_000,
  documents: { '2026-08-25': documentHash(PROFILE, sha256) },
  keys: [{ thumbprint: THUMB, generation: 0, phase: 'active' }],
  ...over,
});

describe('labels', () => {
  it('encodes 128 bits as 26 lower-case base32 characters', () => {
    expect(LABEL).toHaveLength(26);
    expect(LABEL_PATTERN.test(LABEL)).toBe(true);
    expect(labelFromBytes(new Uint8Array(16))).toBe('a'.repeat(26));
    expect(labelFromBytes(new Uint8Array(16).fill(0xff))).toBe('7'.repeat(25) + '4');
    expect(() => labelFromBytes(new Uint8Array(15))).toThrow();
  });
  it('maps exactly <label>.ucp.dinakernel.com to a label, nothing else', () => {
    expect(labelForHostname(`${LABEL}.ucp.dinakernel.com`)).toBe(LABEL);
    expect(labelForHostname(`${LABEL.toUpperCase()}.UCP.DINAKERNEL.COM`)).toBe(LABEL);
    expect(labelForHostname(`${LABEL}-v20260408.ucp.dinakernel.com`)).toBeNull();
    expect(labelForHostname(`x.${LABEL}.ucp.dinakernel.com`)).toBeNull();
    expect(labelForHostname('ucp.dinakernel.com')).toBeNull();
    expect(labelForHostname(`${LABEL}.ucp.dinakernel.com.evil.example`)).toBeNull();
  });
  it('builds the profile URL at /.well-known/ucp', () => {
    expect(profileUrlForLabel(LABEL)).toBe(`https://${LABEL}.ucp.dinakernel.com/.well-known/ucp`);
  });
});

describe('publication envelopes', () => {
  it('signs and verifies an upload', async () => {
    const env = await signPublication(upload(), sign);
    expect(env.domain).toBe('dina:ucp:profile-publication:v1');
    expect(env.host).toBe('ucp.dinakernel.com');
    expect(
      verifyPublication(env, { label: LABEL, profileBytes: PROFILE }, sha256, verify),
    ).toMatchObject({ ok: true });
  });
  it('refuses a copied envelope with altered documents (the hash), another label, and a bad signature', async () => {
    const env = await signPublication(upload(), sign);
    expect(
      verifyPublication(
        env,
        { label: LABEL, profileBytes: PROFILE.replace('ucp', 'ucq') },
        sha256,
        verify,
      ),
    ).toEqual({
      ok: false,
      reason: 'publication_document_hash',
    });
    const other = labelFromBytes(new Uint8Array(16).fill(1));
    expect(verifyPublication(env, { label: other, profileBytes: PROFILE }, sha256, verify)).toEqual(
      {
        ok: false,
        reason: 'publication_label_mismatch',
      },
    );
    const forged = { ...env, revision: 2 };
    expect(
      verifyPublication(forged, { label: LABEL, profileBytes: PROFILE }, sha256, verify),
    ).toEqual({
      ok: false,
      reason: 'publication_signature',
    });
    const otherKey = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    expect(
      verifyPublication(env, { label: LABEL, profileBytes: PROFILE }, sha256, (m, s) =>
        ed25519.verify(s, m, otherKey),
      ),
    ).toEqual({ ok: false, reason: 'publication_signature' });
  });
  it('signs pause (no documents) and retire (thumbprints)', async () => {
    const { documents: _d, keys: _k, ...base } = upload();
    const p = await signPublication({ ...base, op: 'pause' }, sign);
    expect(Object.keys(p)).not.toContain('documents');
    expect(verifyPublication(p, { label: LABEL }, sha256, verify)).toMatchObject({ ok: true });
    // A pause carrying upload members is refused: one shape per operation.
    await expect(signPublication({ ...upload(), op: 'pause' }, sign)).rejects.toThrow(
      'publication: members',
    );
    const r = await signPublication({ ...base, op: 'retire', retire: [THUMB] }, sign);
    expect(verifyPublication(r, { label: LABEL }, sha256, verify)).toMatchObject({ ok: true });
  });
  it.each([
    ['revision 0', { revision: 0 }, 'revision'],
    [
      'no active key',
      { keys: [{ thumbprint: THUMB, generation: 0, phase: 'retiring' as const, retire_after: 5 }] },
      'keys',
    ],
    [
      'a retiring key without retire_after',
      {
        keys: [
          { thumbprint: THUMB, generation: 0, phase: 'active' as const },
          { thumbprint: 'B'.repeat(43), generation: 1, phase: 'retiring' as const },
        ],
      },
      'keys',
    ],
    ['bad label', { label: 'short' }, 'label'],
    ['bad instance', { instance: 'not-a-uuid' }, 'instance'],
    ['bad did', { did: 'did:example:1' }, 'did'],
    [
      'two active keys',
      {
        keys: [
          { thumbprint: THUMB, generation: 0, phase: 'active' as const },
          { thumbprint: 'B'.repeat(43), generation: 1, phase: 'active' as const },
        ],
      },
      'keys',
    ],
    [
      'staged key without not_before',
      {
        keys: [
          { thumbprint: THUMB, generation: 0, phase: 'active' as const },
          { thumbprint: 'B'.repeat(43), generation: 1, phase: 'staged' as const },
        ],
      },
      'keys',
    ],
    [
      'duplicate thumbprint',
      {
        keys: [
          { thumbprint: THUMB, generation: 0, phase: 'active' as const },
          { thumbprint: THUMB, generation: 1, phase: 'retiring' as const, retire_after: 5 },
        ],
      },
      'keys',
    ],
    ['older version document', { documents: { '2026-04-08': 'a'.repeat(64) } }, 'documents'],
  ])('refuses %s', async (_n, over, reason) => {
    const env = {
      v: 1,
      domain: 'dina:ucp:profile-publication:v1',
      host: 'ucp.dinakernel.com',
      ...upload(over as never),
      sig: Buffer.alloc(64).toString('base64'),
    };
    expect(validatePublication(env)).toBe(reason);
  });
  it('accepts a staged key with not_before and a retiring key with retire_after beside the active one', () => {
    const env = {
      v: 1,
      domain: 'dina:ucp:profile-publication:v1',
      host: 'ucp.dinakernel.com',
      ...upload({
        keys: [
          {
            thumbprint: 'B'.repeat(43),
            generation: 0,
            phase: 'retiring',
            retire_after: 1_759_604_800_000,
          },
          { thumbprint: THUMB, generation: 1, phase: 'active' },
          {
            thumbprint: 'C'.repeat(43),
            generation: 2,
            phase: 'staged',
            not_before: 1_759_100_000_000,
          },
        ],
      }),
      sig: Buffer.alloc(64).toString('base64'),
    };
    expect(validatePublication(env)).toBeNull();
  });
  it('checks the label and the document hash before the signature', async () => {
    const env = await signPublication(upload(), sign);
    const neverCalled = () => {
      throw new Error('the signature must not be checked first');
    };
    expect(
      verifyPublication(env, { label: LABEL, profileBytes: `${PROFILE} ` }, sha256, neverCalled),
    ).toEqual({ ok: false, reason: 'publication_document_hash' });
    expect(
      verifyPublication(
        env,
        { label: labelFromBytes(new Uint8Array(16)), profileBytes: PROFILE },
        sha256,
        neverCalled,
      ),
    ).toEqual({ ok: false, reason: 'publication_label_mismatch' });
  });
  it('refuses unknown members', () => {
    const env = {
      v: 1,
      domain: 'dina:ucp:profile-publication:v1',
      host: 'ucp.dinakernel.com',
      ...upload(),
      extra: 1,
      sig: Buffer.alloc(64).toString('base64'),
    };
    expect(validatePublication(env)).toBe('members');
  });
});

describe('the host deployment', () => {
  it('an envelope for one host is refused by another', async () => {
    const forTest = await signPublication(upload(), sign, 'ucp.test.dinakernel.com');
    expect(forTest.host).toBe('ucp.test.dinakernel.com');
    expect(
      verifyPublication(forTest, { label: LABEL, profileBytes: PROFILE }, sha256, verify),
    ).toEqual({
      ok: false,
      reason: 'publication_host',
    });
    expect(
      verifyPublication(
        forTest,
        { label: LABEL, profileBytes: PROFILE, profileHost: 'ucp.test.dinakernel.com' },
        sha256,
        verify,
      ),
    ).toMatchObject({ ok: true });
  });
  it('maps hostnames and builds URLs under a test host', () => {
    expect(labelForHostname(`${LABEL}.ucp.test.dinakernel.com`, 'ucp.test.dinakernel.com')).toBe(
      LABEL,
    );
    expect(labelForHostname(`${LABEL}.ucp.test.dinakernel.com`)).toBeNull();
    expect(profileUrlForLabel(LABEL, 'ucp.test.dinakernel.com')).toBe(
      `https://${LABEL}.ucp.test.dinakernel.com/.well-known/ucp`,
    );
    expect(dropBoxWebhookUrl(LABEL)).toBe(`https://${LABEL}.ucp.dinakernel.com/webhooks/orders`);
    expect(() => profileUrlForLabel(LABEL, 'Bad Host')).toThrow(/bad host/);
  });
});
