/**
 * The DID binding wire (design §5.1, M4): what a client signs, and the one
 * body shape Core accepts.
 */

import {
  DID_BINDING_DOMAIN,
  DID_REQUEST_DOMAIN,
  DINA_REQUEST_SIGNING,
  didBindingSigningInput,
  didRequestSigningInput,
  parseDidBindingRequest,
} from '../src';

const CHALLENGE = `dch_${'A'.repeat(43)}`;
const SIG = 'ab'.repeat(64);

it('signs the domain, the node, the client, the DID and the challenge, one per line', () => {
  expect(
    didBindingSigningInput({
      nodeDid: 'did:plc:n',
      clientId: 'ac_1',
      did: 'did:key:z6Mk',
      challenge: CHALLENGE,
    }).split('\n'),
  ).toEqual([DID_BINDING_DOMAIN, 'did:plc:n', 'ac_1', 'did:key:z6Mk', CHALLENGE]);
});

it('signs each request under its own domain and its audience, then the request itself, one per line', () => {
  const parts = {
    nodeDid: 'did:plc:node',
    method: 'POST',
    path: '/a2a/v1',
    query: 'A2A-Version=1.0',
    timestamp: '2026-10-04T12:00:00Z',
    nonce: 'n'.repeat(32),
    bodySha256Hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };
  expect(didRequestSigningInput(parts).split('\n')).toEqual([
    DID_REQUEST_DOMAIN,
    'did:plc:node',
    'POST',
    '/a2a/v1',
    'A2A-Version=1.0',
    '2026-10-04T12:00:00Z',
    'n'.repeat(32),
    parts.bodySha256Hex,
  ]);
  // The rule the card states is the text built here, placeholder for placeholder.
  expect(DINA_REQUEST_SIGNING.canonical.split('\n')).toEqual([
    DID_REQUEST_DOMAIN,
    '{NODE_DID}',
    '{METHOD}',
    '{PATH}',
    '{QUERY}',
    '{TIMESTAMP}',
    '{NONCE}',
    '{SHA256_HEX(BODY)}',
  ]);
  // The domains differ, so a binding signature is never a request signature, nor the reverse.
  expect(DID_REQUEST_DOMAIN).not.toBe(DID_BINDING_DOMAIN);
});

describe('parseDidBindingRequest', () => {
  it('reads exactly {did, challenge, signature}', () => {
    expect(
      parseDidBindingRequest(
        JSON.stringify({ did: 'did:plc:abc', challenge: CHALLENGE, signature: SIG }),
      ),
    ).toEqual({
      did: 'did:plc:abc',
      challenge: CHALLENGE,
      signature: SIG,
    });
  });

  it.each([
    [
      'an extra member',
      { did: 'did:plc:abc', challenge: CHALLENGE, signature: SIG, client_id: 'x' },
    ],
    ['a missing member', { did: 'did:plc:abc', challenge: CHALLENGE }],
    ['a DID that is not one', { did: 'plc:abc', challenge: CHALLENGE, signature: SIG }],
    [
      'a challenge of another shape',
      { did: 'did:plc:abc', challenge: 'dch_short', signature: SIG },
    ],
    [
      'an upper-case signature',
      { did: 'did:plc:abc', challenge: CHALLENGE, signature: SIG.toUpperCase() },
    ],
    ['a short signature', { did: 'did:plc:abc', challenge: CHALLENGE, signature: 'ab' }],
  ])('refuses %s', (_name, body) => {
    expect(parseDidBindingRequest(JSON.stringify(body))).toBeNull();
  });

  it('refuses a duplicate member rather than reading the last', () => {
    expect(
      parseDidBindingRequest(
        `{"did":"did:plc:a","did":"did:plc:b","challenge":"${CHALLENGE}","signature":"${SIG}"}`,
      ),
    ).toBeNull();
  });
});
