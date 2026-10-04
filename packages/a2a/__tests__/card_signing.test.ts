import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';

import {
  base64urlDecodeUtf8,
  base64urlEncodeUtf8,
  CardFormError,
  base64urlEncode,
  cardPinText,
  cardSigningContent,
  parseProtectedHeader,
  signAgentCard,
  verifyAgentCardSignatures,
  type JwsVerifyFn,
} from '../src';

const card = (): Record<string, unknown> => ({
  name: 'Agent',
  description: 'Does things',
  supportedInterfaces: [
    {
      url: 'https://a.example/rpc',
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: '1.0',
    },
  ],
  version: '1',
  capabilities: { streaming: false, extensions: [] },
  securitySchemes: {},
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'], examples: [] }],
});

describe('card canonical form (spec §8.4.1)', () => {
  it('drops default-valued non-required fields and keeps required ones', () => {
    const content = cardSigningContent(card());
    expect(content).toEqual({
      name: 'Agent',
      description: 'Does things',
      supportedInterfaces: [
        { url: 'https://a.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      version: '1',
      capabilities: { streaming: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'] }],
    });
  });

  it('keeps an optional field set to its default, and drops a plain default', () => {
    const content = cardSigningContent({
      ...card(),
      capabilities: {
        extendedAgentCard: false,
        extensions: [{ uri: 'u', required: false, description: '' }],
      },
    });
    expect(content.capabilities).toEqual({ extendedAgentCard: false, extensions: [{ uri: 'u' }] });
  });

  it('excludes signatures and keeps unknown members verbatim', () => {
    const content = cardSigningContent({
      ...card(),
      signatures: [{ protected: 'p', signature: 's' }],
      future: { x: '' },
    });
    expect(content).not.toHaveProperty('signatures');
    expect(content.future).toEqual({ x: '' });
  });

  it('never strips inside a Struct (extension params)', () => {
    const content = cardSigningContent({
      ...card(),
      capabilities: { extensions: [{ uri: 'u', params: { empty: '', list: [], flag: false } }] },
    });
    expect(content.capabilities).toEqual({
      extensions: [{ uri: 'u', params: { empty: '', list: [], flag: false } }],
    });
  });

  it('pins content plus verified signers, never signature bytes', () => {
    const unsigned = cardPinText(card(), []);
    // Re-signing unchanged content (randomized ECDSA) must not look like a changed card.
    const resigned1 = cardPinText(
      { ...card(), signatures: [{ protected: 'p', signature: 's1' }] },
      ['k#1'],
    );
    const resigned2 = cardPinText(
      { ...card(), signatures: [{ protected: 'p', signature: 's2' }] },
      ['k#1'],
    );
    expect(resigned1).toBe(resigned2);
    // Who vouches is part of the pin: a new key, or a lost signature, re-gates.
    expect(resigned1).not.toBe(unsigned);
    expect(cardPinText(card(), ['k#2'])).not.toBe(resigned1);
    expect(cardPinText(card(), ['k#1', 'k#1'])).toBe(resigned1);
    expect(cardPinText(card(), ['b', 'a'])).toBe(cardPinText(card(), ['a', 'b']));
    // Content changes always re-gate; null and undefined members are unset, not content.
    expect(cardPinText({ ...card(), version: '2' }, [])).not.toBe(unsigned);
    expect(cardPinText({ ...card(), tenantless: undefined, iconUrl: null }, [])).toBe(unsigned);
  });

  it('restores REQUIRED fields an emitter left out at their default (spec §8.4.1)', () => {
    const full = card();
    const { description: _d, ...withoutDescription } = full;
    const content = cardSigningContent(withoutDescription);
    expect(content.description).toBe('');
    const { capabilities: _c, ...withoutCaps } = full;
    expect(cardSigningContent(withoutCaps).capabilities).toEqual({});
  });

  it('matches the spec §8.4.1 worked example', () => {
    const fragment = {
      name: 'Example Agent',
      description: '',
      capabilities: { streaming: false, pushNotifications: false, extensions: [] },
      skills: [],
    };
    const content = cardSigningContent(fragment);
    // The example omits the other REQUIRED members; compare the members it shows.
    expect({
      capabilities: content.capabilities,
      description: content.description,
      name: content.name,
      skills: content.skills,
    }).toEqual({
      capabilities: { pushNotifications: false, streaming: false },
      description: '',
      name: 'Example Agent',
      skills: [],
    });
  });

  it('has no canonical form for a card carrying __proto__ or nested past the cap', () => {
    const poisoned = JSON.parse('{"name":"a","__proto__":{"x":1}}') as Record<string, unknown>;
    expect(() => cardSigningContent({ ...card(), ...poisoned })).toThrow(CardFormError);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(() =>
      cardSigningContent({ ...card(), capabilities: { extensions: [{ uri: 'u', params: deep }] } }),
    ).toThrow(CardFormError);
  });
});

describe('card JWS signatures (spec §8.4.2–§8.4.3)', () => {
  const es256Secret = p256.utils.randomSecretKey();
  const es256Public = p256.getPublicKey(es256Secret);
  const edSecret = ed25519.utils.randomSecretKey();
  const edPublic = ed25519.getPublicKey(edSecret);

  const verify: JwsVerifyFn = ({ header, signingInputs, signature }) => {
    if (header.alg === 'ES256' && header.kid === 'p256-1')
      return signingInputs.some((input) => p256.verify(signature, input, es256Public));
    if (header.alg === 'EdDSA' && header.kid === 'ed-1')
      return signingInputs.some((input) => ed25519.verify(signature, input, edPublic));
    return false;
  };

  it('signs with ES256 and verifies', async () => {
    const sig = await signAgentCard(
      card(),
      { alg: 'ES256', typ: 'JOSE', kid: 'p256-1', jku: 'https://a.example/jwks.json' },
      (input) => p256.sign(input, es256Secret),
    );
    expect(JSON.parse(base64urlDecodeUtf8(sig.protected) as string)).toEqual({
      alg: 'ES256',
      typ: 'JOSE',
      kid: 'p256-1',
      jku: 'https://a.example/jwks.json',
    });
    const report = await verifyAgentCardSignatures({ ...card(), signatures: [sig] }, verify);
    expect(report).toEqual({
      state: 'verified',
      verifiedKids: ['p256-1'],
      verifiedSigners: ['https://a.example/jwks.json#p256-1'],
    });
  });

  it('verifies the same signature whether or not the sender spelled out defaults', async () => {
    const sig = await signAgentCard(card(), { alg: 'EdDSA', typ: 'JOSE', kid: 'ed-1' }, (input) =>
      ed25519.sign(input, edSecret),
    );
    const lean = cardSigningContent(card());
    expect((await verifyAgentCardSignatures({ ...lean, signatures: [sig] }, verify)).state).toBe(
      'verified',
    );
  });

  it('reports a tampered card as invalid', async () => {
    const sig = await signAgentCard(card(), { alg: 'EdDSA', typ: 'JOSE', kid: 'ed-1' }, (input) =>
      ed25519.sign(input, edSecret),
    );
    const tampered = { ...card(), description: 'Does other things', signatures: [sig] };
    expect(await verifyAgentCardSignatures(tampered, verify)).toEqual({
      state: 'invalid',
      verifiedKids: [],
      verifiedSigners: [],
    });
  });

  it('reports a card with no signatures as unsigned', async () => {
    expect((await verifyAgentCardSignatures(card(), verify)).state).toBe('unsigned');
    expect((await verifyAgentCardSignatures({ ...card(), signatures: [] }, verify)).state).toBe(
      'unsigned',
    );
  });

  it('accepts a card when one of several signatures verifies (key rotation)', async () => {
    const good = await signAgentCard(card(), { alg: 'EdDSA', typ: 'JOSE', kid: 'ed-1' }, (input) =>
      ed25519.sign(input, edSecret),
    );
    const unknown = await signAgentCard(
      card(),
      { alg: 'EdDSA', typ: 'JOSE', kid: 'retired' },
      (input) => ed25519.sign(input, edSecret),
    );
    const report = await verifyAgentCardSignatures(
      { ...card(), signatures: [unknown, good] },
      verify,
    );
    expect(report).toEqual({
      state: 'verified',
      verifiedKids: ['ed-1'],
      verifiedSigners: ['#ed-1'],
    });
  });

  it('names a verified signer by the key identity the verifier returns', async () => {
    const sig = await signAgentCard(card(), { alg: 'EdDSA', kid: 'ed-1' }, (input) =>
      ed25519.sign(input, edSecret),
    );
    const report = await verifyAgentCardSignatures({ ...card(), signatures: [sig] }, (args) =>
      verify(args) === true ? { signer: 'thumbprint:abc' } : false,
    );
    expect(report.verifiedSigners).toEqual(['thumbprint:abc']);
  });

  it('will not sign with a DER-encoded ES256 signature (JWS needs raw r||s)', async () => {
    await expect(
      signAgentCard(card(), { alg: 'ES256', typ: 'JOSE', kid: 'p256-1' }, (input) =>
        p256.sign(input, es256Secret, { format: 'der' }),
      ),
    ).rejects.toThrow(/64 raw bytes/);
  });

  it('refuses a signature of the wrong length before the verifier sees it', async () => {
    const good = await signAgentCard(
      card(),
      { alg: 'ES256', typ: 'JOSE', kid: 'p256-1' },
      (input) => p256.sign(input, es256Secret),
    );
    const der = p256.sign(new Uint8Array(32), es256Secret, { format: 'der' });
    let calls = 0;
    const counting: JwsVerifyFn = (args) => {
      calls += 1;
      return verify(args);
    };
    const report = await verifyAgentCardSignatures(
      { ...card(), signatures: [{ protected: good.protected, signature: base64urlEncode(der) }] },
      counting,
    );
    expect(report.state).toBe('invalid');
    expect(calls).toBe(0);
  });

  it('reports a malformed signatures member as invalid, not unsigned', async () => {
    expect((await verifyAgentCardSignatures({ ...card(), signatures: 'x' }, verify)).state).toBe(
      'invalid',
    );
  });

  it('reports the typ the signer wrote', async () => {
    const header = parseProtectedHeader(
      base64urlEncodeUtf8(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k' })),
    );
    expect(header?.typ).toBe('JWT');
  });

  it.each([
    ['alg none', { alg: 'none', kid: 'k' }],
    ['alg HS256', { alg: 'HS256', kid: 'k' }],
    ['no kid', { alg: 'ES256' }],
    ['an empty kid', { alg: 'ES256', kid: '' }],
    ['a crit member', { alg: 'ES256', kid: 'k', crit: ['exp'] }],
    ['a non-string jku', { alg: 'ES256', kid: 'k', jku: 1 }],
  ])('refuses a protected header with %s', (_name, header) => {
    expect(parseProtectedHeader(base64urlEncodeUtf8(JSON.stringify(header)))).toBeNull();
  });

  it('tolerates a typ other than JOSE (SHOULD, not MUST)', () => {
    expect(
      parseProtectedHeader(
        base64urlEncodeUtf8(JSON.stringify({ alg: 'ES256', kid: 'k', typ: 'JWT' })),
      ),
    ).not.toBeNull();
  });

  it('refuses a protected header that is not base64url JSON', () => {
    expect(parseProtectedHeader('not base64!')).toBeNull();
    expect(parseProtectedHeader(base64urlEncodeUtf8('[1]'))).toBeNull();
  });
});
