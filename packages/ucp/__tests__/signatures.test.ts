import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64urlDecode, utf8Bytes } from '@dina/a2a';

import { es256Thumbprint } from '../src/jwk';
import { parseDictionary, dictGet } from '../src/sf';
import {
  contentDigest,
  contentDigestMatches,
  requiredRequestComponents,
  requiredResponseComponents,
  requiredWebhookComponents,
  signatureBase,
  signRequest,
  verifyMessage,
  type CoveredComponent,
  type HttpMessage,
  type KeyLookup,
  type VerificationKey,
} from '../src/signatures';

// RFC 9421 Appendix B.1.3, test-key-ecc-p256.
const RFC_D = base64urlDecode('UpuF81l-kOxbjf7T4mNSv0r5tN67Gim7rnf6EFpcYDs') as Uint8Array;
const RFC_X = base64urlDecode('qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA') as Uint8Array;
const RFC_Y = base64urlDecode('Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0') as Uint8Array;
const RFC_PUBLIC = new Uint8Array([0x04, ...RFC_X, ...RFC_Y]);

const verifyWith =
  (publicKey: Uint8Array) =>
  (base: Uint8Array, signature: Uint8Array): boolean =>
    p256.verify(signature, base, publicKey, { lowS: false });

/** The RFC key's RFC 7638 thumbprint, as its profile would publish it as `kid`. */
const RFC_THUMBPRINT = es256Thumbprint(
  Buffer.from(RFC_X).toString('base64url'),
  Buffer.from(RFC_Y).toString('base64url'),
  sha256,
);
const RFC_KEY: VerificationKey = { verify: verifyWith(RFC_PUBLIC), thumbprint: RFC_THUMBPRINT };
/** The RFC key, listed under each of these kids. */
const keysUnder =
  (...kids: string[]): KeyLookup =>
  (keyid) =>
    kids.includes(keyid) ? RFC_KEY : null;
/** A lookup that must not be reached (coverage and digest come first). */
const neverAsked: KeyLookup = () => {
  throw new Error('the key lookup must not be reached');
};

/** Sign any message over the given components and parameters with the RFC key. */
function signMessage(
  msg: HttpMessage,
  covered: (string | CoveredComponent)[],
  paramsText: string,
  label = 'sig1',
): HttpMessage {
  const inner = `(${covered
    .map((c) => (typeof c === 'string' ? `"${c}"` : `"${c.name}";key="${c.key}"`))
    .join(' ')})${paramsText}`;
  const member = dictGet(parseDictionary(`${label}=${inner}`), label);
  if (member?.kind !== 'inner-list') throw new Error('bad params');
  const base = signatureBase(msg, covered, member.params);
  const sig = Buffer.from(p256.sign(utf8Bytes(base), RFC_D)).toString('base64');
  return {
    ...msg,
    headers: {
      ...msg.headers,
      'signature-input': `${label}=${inner}`,
      signature: `${label}=:${sig}:`,
    },
  };
}

describe('RFC 9421 Appendix B.2.4 (ecdsa-p256-sha256 response)', () => {
  // The test-response message of Appendix B.2.
  const response: HttpMessage = {
    status: 200,
    headers: {
      date: 'Tue, 20 Apr 2021 02:07:56 GMT',
      'content-type': 'application/json',
      'content-digest':
        'sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
      'content-length': '23',
    },
    body: utf8Bytes('{"message": "good dog"}'),
  };
  const covered = ['@status', 'content-type', 'content-digest', 'content-length'];
  const sigInput = parseDictionary(
    'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
  );
  const member = dictGet(sigInput, 'sig-b24');
  const params = member?.kind === 'inner-list' ? member.params : [];

  it('builds the signature base byte for byte', () => {
    expect(signatureBase(response, covered, params)).toBe(
      [
        '"@status": 200',
        '"content-type": application/json',
        '"content-digest": sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
        '"content-length": 23',
        '"@signature-params": ("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
      ].join('\n'),
    );
  });

  it("verifies the RFC's own signature with the RFC's public key", () => {
    const sig = dictGet(
      parseDictionary(
        'sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:',
      ),
      'sig-b24',
    );
    if (sig?.kind !== 'item' || sig.value.type !== 'bytes') throw new Error('bad vector');
    const base = utf8Bytes(signatureBase(response, covered, params));
    expect(verifyWith(RFC_PUBLIC)(base, sig.value.value)).toBe(true);
    // One flipped bit in the base fails.
    base[3] = (base[3] as number) ^ 1;
    expect(verifyWith(RFC_PUBLIC)(base, sig.value.value)).toBe(false);
  });
});

describe('RFC 9421 derived components on the RFC test-request', () => {
  const request: HttpMessage = {
    method: 'post',
    url: 'https://example.com/foo?param=Value&Pet=dog',
    headers: { 'content-type': 'application/json' },
  };
  it('matches the values Appendix B.2.3 shows', () => {
    expect(
      signatureBase(request, ['@method', '@path', '@query', '@authority', 'content-type'], []),
    ).toBe(
      [
        '"@method": POST',
        '"@path": /foo',
        '"@query": ?param=Value&Pet=dog',
        '"@authority": example.com',
        '"content-type": application/json',
        '"@signature-params": ("@method" "@path" "@query" "@authority" "content-type")',
      ].join('\n'),
    );
  });

  it('keeps a non-default port in @authority, lower-cases the host, and uses "/" and "?" for empty path and query', () => {
    const msg: HttpMessage = { method: 'GET', url: 'https://Shop.Example:8443', headers: {} };
    expect(signatureBase(msg, ['@authority', '@path', '@query'], [])).toContain(
      '"@authority": shop.example:8443\n"@path": /\n"@query": ?',
    );
  });

  it('refuses a covered header that is missing, and a component covered twice', () => {
    expect(() => signatureBase(request, ['date'], [])).toThrow(/missing/);
    expect(() => signatureBase(request, ['@method', '@method'], [])).toThrow(/twice/);
  });
});

describe('Content-Digest (RFC 9530, sha-256 over the exact bytes)', () => {
  it('computes and checks a sha-256 digest', () => {
    const body = utf8Bytes('{"a":1}');
    const header = contentDigest(body, sha256);
    expect(header).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
    expect(contentDigestMatches(header, body, sha256)).toBe(true);
    expect(contentDigestMatches(header, utf8Bytes('{"a": 1}'), sha256)).toBe(false);
  });
  it('refuses a digest with no sha-256 member or a malformed header', () => {
    expect(contentDigestMatches('sha-512=:AAAA:', utf8Bytes(''), sha256)).toBe(false);
    expect(contentDigestMatches('not a dictionary', utf8Bytes(''), sha256)).toBe(false);
  });
});

describe('UCP coverage rules', () => {
  it('requires the full set on a signed POST with a body', () => {
    const msg: HttpMessage = {
      method: 'POST',
      url: 'https://shop.example/ucp/checkout-sessions',
      headers: {
        'ucp-agent': 'profile="x"',
        'idempotency-key': 'k',
        'content-type': 'application/json',
      },
      body: utf8Bytes('{}'),
    };
    expect(requiredRequestComponents(msg)).toEqual([
      '@method',
      '@authority',
      '@path',
      'ucp-agent',
      'idempotency-key',
      'content-digest',
      'content-type',
    ]);
  });
  it('adds @query only with a query, and nothing for an absent body', () => {
    const msg: HttpMessage = {
      method: 'GET',
      url: 'https://shop.example/ucp/orders/1?x=1',
      headers: {},
    };
    expect(requiredRequestComponents(msg)).toEqual(['@method', '@authority', '@path', '@query']);
  });
  it('response: @status plus the body pair', () => {
    expect(requiredResponseComponents({ status: 200, headers: {}, body: utf8Bytes('{}') })).toEqual(
      ['@status', 'content-digest', 'content-type'],
    );
    expect(requiredResponseComponents({ status: 204, headers: {} })).toEqual(['@status']);
  });
  it('webhook: does not demand ucp-agent (S16), even when the header is present', () => {
    expect(
      requiredWebhookComponents({
        method: 'POST',
        url: 'https://n.example/ucp/webhooks/orders',
        headers: { 'ucp-agent': 'profile="x"' },
        body: utf8Bytes('{}'),
      }),
    ).toEqual(['@method', '@authority', '@path', 'content-digest', 'content-type']);
  });
});

describe('signing and verifying a UCP request', () => {
  const keyFor = keysUnder('k1');
  const base: Omit<Parameters<typeof signRequest>[0], 'sign'> = {
    method: 'POST',
    url: 'https://shop.example/ucp/checkout-sessions',
    headers: {
      'content-type': 'application/json',
      'ucp-agent':
        'profile="https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/.well-known/ucp"',
      'idempotency-key': '550e8400-e29b-41d4-a716-446655440000',
    },
    body: utf8Bytes('{"line_items":[{"item":{"id":"v1"},"quantity":1}]}'),
    keyid: 'k1',
    sha256,
  };
  const signed = (): HttpMessage => {
    const added = signRequest({ ...base, sign: (b) => p256.sign(b, RFC_D) });
    return {
      method: base.method,
      url: base.url,
      headers: { ...base.headers, ...added },
      body: base.body as Uint8Array,
    };
  };

  it('signs with raw 64-byte r||s and covers every required component', () => {
    const msg = signed();
    expect(msg.headers['signature-input']).toBe(
      'sig1=("@method" "@authority" "@path" "ucp-agent" "idempotency-key" "content-digest" "content-type");keyid="k1"',
    );
    const sig = dictGet(parseDictionary(msg.headers['signature'] as string), 'sig1');
    expect(sig?.kind === 'item' && sig.value.type === 'bytes' && sig.value.value.length).toBe(64);
  });

  it('verifies its own signature', () => {
    const msg = signed();
    expect(
      verifyMessage({ msg, required: requiredRequestComponents(msg), keyFor, sha256 }),
    ).toEqual({
      ok: true,
      label: 'sig1',
      keyid: 'k1',
    });
  });

  it('refuses an altered header (signature), an unknown key and too little coverage', () => {
    const headerChanged = signed();
    const hc: HttpMessage = {
      ...headerChanged,
      headers: { ...headerChanged.headers, 'idempotency-key': 'other' },
    };
    expect(
      verifyMessage({ msg: hc, required: requiredRequestComponents(hc), keyFor, sha256 }),
    ).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
    const msg = signed();
    expect(
      verifyMessage({ msg, required: requiredRequestComponents(msg), keyFor: () => null, sha256 }),
    ).toEqual({ ok: false, reason: 'key_not_found' });
    expect(
      verifyMessage({ msg, required: [...requiredRequestComponents(msg), 'date'], keyFor, sha256 }),
    ).toEqual({ ok: false, reason: 'coverage_insufficient' });
  });

  it('checks coverage and the digest before it looks up a key (no refresh for a forgery)', () => {
    const msg = signed();
    expect(
      verifyMessage({
        msg: { ...msg, body: utf8Bytes('{}') },
        required: requiredRequestComponents(msg),
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'digest_mismatch' });
    expect(
      verifyMessage({
        msg,
        required: [...requiredRequestComponents(msg), 'date'],
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'coverage_insufficient' });
  });

  it('accepts a message when one of two signatures passes, and never on the under-covered one alone', () => {
    const msg = signed();
    const weak = signMessage(msg, ['@method', '@authority', '@path'], ';keyid="k1"', 'weak');
    const both: HttpMessage = {
      ...msg,
      headers: {
        ...msg.headers,
        'signature-input': `${weak.headers['signature-input']}, ${msg.headers['signature-input']}`,
        signature: `${weak.headers['signature']}, ${msg.headers['signature']}`,
      },
    };
    expect(
      verifyMessage({ msg: both, required: requiredRequestComponents(msg), keyFor, sha256 }),
    ).toMatchObject({
      ok: true,
      label: 'sig1',
    });
    // The full signature corrupted in place: only the under-covered one verifies, which is not enough.
    const corrupted: HttpMessage = {
      ...both,
      headers: {
        ...both.headers,
        signature: `${weak.headers['signature']}, sig1=:${Buffer.alloc(64, 7).toString('base64')}:`,
      },
    };
    expect(
      verifyMessage({ msg: corrupted, required: requiredRequestComponents(msg), keyFor, sha256 }),
    ).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('reports a missing or malformed signature', () => {
    const msg = signed();
    const noSig: HttpMessage = { ...msg, headers: { ...msg.headers } };
    delete (noSig.headers as Record<string, string>)['signature'];
    expect(verifyMessage({ msg: noSig, required: [], keyFor, sha256 })).toEqual({
      ok: false,
      reason: 'signature_missing',
    });
    const bad: HttpMessage = { ...msg, headers: { ...msg.headers, signature: 'sig1=nope(' } };
    expect(verifyMessage({ msg: bad, required: [], keyFor, sha256 })).toEqual({
      ok: false,
      reason: 'signature_malformed',
    });
  });

  it('skips a tag other than web-bot-auth (overview step 1)', () => {
    const msg = signed();
    const tagged = signMessage(msg, requiredRequestComponents(msg), ';keyid="k1";tag="other"');
    expect(
      verifyMessage({ msg: tagged, required: requiredRequestComponents(msg), keyFor, sha256 }),
    ).toEqual({ ok: false, reason: 'tag_unsupported' });
  });

  it('accepts alg only when it names the key algorithm (RFC 9421 §3.2)', () => {
    const msg = signed();
    const named = signMessage(
      msg,
      requiredRequestComponents(msg),
      ';keyid="k1";alg="ecdsa-p256-sha256"',
    );
    expect(
      verifyMessage({ msg: named, required: requiredRequestComponents(msg), keyFor, sha256 }),
    ).toMatchObject({
      ok: true,
    });
    const other = signMessage(msg, requiredRequestComponents(msg), ';keyid="k1";alg="ed25519"');
    expect(
      verifyMessage({ msg: other, required: requiredRequestComponents(msg), keyFor, sha256 }),
    ).toEqual({
      ok: false,
      reason: 'algorithm_unsupported',
    });
  });

  it('refuses component parameters other than a header key, and a throwing verifier counts as invalid', () => {
    const msg = signed();
    const sfParam: HttpMessage = {
      ...msg,
      headers: {
        ...msg.headers,
        'signature-input': (msg.headers['signature-input'] as string).replace(
          '"ucp-agent"',
          '"ucp-agent";sf',
        ),
      },
    };
    expect(verifyMessage({ msg: sfParam, required: [], keyFor, sha256 })).toEqual({
      ok: false,
      reason: 'signature_malformed',
    });
    const throwing: KeyLookup = () => ({
      thumbprint: RFC_THUMBPRINT,
      verify: () => {
        throw new Error('bad key');
      },
    });
    expect(verifyMessage({ msg, required: [], keyFor: throwing, sha256 })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('a body needs a content-type, and Dina never sends Signature-Agent', () => {
    expect(() =>
      signRequest({
        ...base,
        headers: { 'ucp-agent': 'profile="x"' },
        sign: (b) => p256.sign(b, RFC_D),
      }),
    ).toThrow(/content-type/);
    expect(() =>
      signRequest({
        ...base,
        headers: { ...base.headers, 'signature-agent': 'sig1="https://a.example"' },
        sign: (b) => p256.sign(b, RFC_D),
      }),
    ).toThrow(/Signature-Agent/);
  });
});

describe('verifying what Dina receives: responses and order webhooks', () => {
  const body = utf8Bytes('{"ucp":{"version":"2026-08-25"},"id":"chk_1"}');
  const response: HttpMessage = {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-digest': contentDigest(body, sha256) },
    body,
  };
  const webhookBody = utf8Bytes('{"id":"ord_1","checkout_id":"chk_1"}');
  const webhook: HttpMessage = {
    method: 'POST',
    url: 'https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/webhooks/orders',
    headers: {
      'content-type': 'application/json',
      'content-digest': contentDigest(webhookBody, sha256),
      'webhook-id': 'wh_1',
    },
    body: webhookBody,
  };

  it('a response signed over @status and the body pair verifies', () => {
    const signedResponse = signMessage(
      response,
      ['@status', 'content-digest', 'content-type'],
      ';keyid="m1"',
    );
    expect(
      verifyMessage({
        msg: signedResponse,
        required: requiredResponseComponents(signedResponse),
        keyFor: keysUnder('m1'),
        sha256,
      }),
    ).toEqual({ ok: true, label: 'sig1', keyid: 'm1' });
  });

  it('refuses a status-only signature on a response with a body, and one that does not cover its digest', () => {
    const statusOnly = signMessage(response, ['@status'], ';keyid="m1"');
    expect(
      verifyMessage({
        msg: statusOnly,
        required: requiredResponseComponents(statusOnly),
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'coverage_insufficient' });
    const noDigest = signMessage(response, ['@status', 'content-type'], ';keyid="m1"');
    expect(
      verifyMessage({
        msg: noDigest,
        required: requiredResponseComponents(noDigest),
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'coverage_insufficient' });
  });

  it('refuses an altered response body', () => {
    const signedResponse = signMessage(
      response,
      ['@status', 'content-digest', 'content-type'],
      ';keyid="m1"',
    );
    expect(
      verifyMessage({
        msg: {
          ...signedResponse,
          body: utf8Bytes('{"ucp":{"version":"2026-08-25"},"id":"chk_2"}'),
        },
        required: requiredResponseComponents(signedResponse),
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('an order webhook signed over target and body verifies without ucp-agent (S16); altered or under-covered, it does not', () => {
    const covered = ['@method', '@authority', '@path', 'content-digest', 'content-type'];
    const signedHook = signMessage(webhook, covered, ';keyid="m1"');
    expect(
      verifyMessage({
        msg: signedHook,
        required: requiredWebhookComponents(signedHook),
        keyFor: keysUnder('m1'),
        sha256,
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifyMessage({
        msg: { ...signedHook, body: utf8Bytes('{"id":"ord_1","checkout_id":"chk_9"}') },
        required: requiredWebhookComponents(signedHook),
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'digest_mismatch' });
    const noPath = signMessage(
      webhook,
      ['@method', '@authority', 'content-digest', 'content-type'],
      ';keyid="m1"',
    );
    expect(
      verifyMessage({
        msg: noPath,
        required: requiredWebhookComponents(noPath),
        keyFor: neverAsked,
        sha256,
      }),
    ).toEqual({ ok: false, reason: 'coverage_insufficient' });
  });

  describe('the dual-audience (web-bot-auth) shape', () => {
    const agent = 'sig1="https://merchant.example/.well-known/http-message-signatures-directory"';
    const hook: HttpMessage = {
      ...webhook,
      headers: { ...webhook.headers, 'signature-agent': agent },
    };
    const covered: (string | CoveredComponent)[] = [
      '@method',
      '@authority',
      '@path',
      { name: 'signature-agent', key: 'sig1' },
      'content-digest',
      'content-type',
    ];

    it('selects the Signature-Agent member per RFC 9421 §2.1.2 in the base', () => {
      expect(signatureBase(hook, covered, [])).toContain(
        '"signature-agent";key="sig1": "https://merchant.example/.well-known/http-message-signatures-directory"',
      );
      expect(() => signatureBase(hook, [{ name: 'signature-agent', key: 'sig2' }], [])).toThrow(
        /no member/,
      );
      expect(() => signatureBase(hook, [{ name: '@path', key: 'x' }], [])).toThrow(/no key/);
    });

    it('verifies when keyid is the key thumbprint', () => {
      const wba = signMessage(
        hook,
        covered,
        `;keyid="${RFC_THUMBPRINT}";created=1738617600;expires=1738621200;tag="web-bot-auth"`,
      );
      expect(
        verifyMessage({
          msg: wba,
          required: requiredWebhookComponents(wba),
          keyFor: keysUnder(RFC_THUMBPRINT),
          sha256,
        }),
      ).toEqual({ ok: true, label: 'sig1', keyid: RFC_THUMBPRINT });
    });

    it('refuses it when keyid is not the thumbprint, even if a key is listed under that kid', () => {
      const wba = signMessage(hook, covered, ';keyid="m1";tag="web-bot-auth"');
      expect(
        verifyMessage({
          msg: wba,
          required: requiredWebhookComponents(wba),
          keyFor: keysUnder('m1'),
          sha256,
        }),
      ).toEqual({ ok: false, reason: 'signature_invalid' });
    });
  });
});
