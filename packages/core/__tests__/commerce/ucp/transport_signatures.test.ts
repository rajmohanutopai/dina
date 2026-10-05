/**
 * Signatures on the UCP transport (UCP plan §3.2, U2.1; T-U2-1, T-U2-1a):
 * every request signed with the node's key, at TLS 1.3; a merchant's signed
 * answer verified against the keys its profile lists, with one refresh for
 * a key it does not list; a signature that fails is a lost answer.
 */

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  contentDigest,
  es256PublicJwk,
  requiredRequestComponents,
  signatureBase,
  verifyMessage,
  type HttpMessage,
  type MerchantProfile,
} from '@dina/ucp';

import { setUcpPolicySocket } from '../../../src/commerce/ucp/fetch';
import { deriveUcpIdentity } from '../../../src/commerce/ucp/identity';
import { merchantKeyLookup } from '../../../src/commerce/ucp/merchant_client';
import { UcpTransport, type MerchantKeys } from '../../../src/commerce/ucp/transport';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const IDENTITY = deriveUcpIdentity(new Uint8Array(32).fill(3), 0);
const DINA_KEYS = merchantKeyLookup({ keys: [IDENTITY.key.jwk] } as unknown as MerchantProfile);
const PROFILE = 'https://abc.ucp.dinakernel.com/.well-known/ucp';

/** A merchant's signing key and its profile entry. */
function merchantKey(kid?: string) {
  const secret = p256.utils.randomSecretKey();
  const jwk = es256PublicJwk(p256.getPublicKey(secret, false), sha256);
  return { secret, jwk: kid === undefined ? jwk : { ...jwk, kid } };
}

/** A JSON answer signed over `components`, as a merchant signs one. */
function signedAnswer(
  key: ReturnType<typeof merchantKey>,
  body: string,
  components: string[] = ['@status', 'content-digest', 'content-type'],
  tamper?: string,
): UcpFetchResult {
  const bodyBytes = new TextEncoder().encode(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-digest': contentDigest(bodyBytes, sha256),
  };
  const msg: HttpMessage = { status: 200, headers, body: bodyBytes };
  const base = signatureBase(msg, components, [['keyid', { type: 'string', value: key.jwk.kid }]]);
  const params = base.slice(
    base.lastIndexOf('"@signature-params": ') + '"@signature-params": '.length,
  );
  const sig = p256.sign(new TextEncoder().encode(base), key.secret);
  const signed = {
    ...headers,
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${Buffer.from(sig).toString('base64')}:`,
  };
  const covered = Object.fromEntries(
    components
      .filter((c) => !c.startsWith('@'))
      .map((c) => [c, signed[c as keyof typeof signed] as string]),
  );
  return {
    ok: true,
    status: 200,
    bodyBytes: tamper === undefined ? bodyBytes : new TextEncoder().encode(tamper),
    headers: signed,
    signedHeaders: { ok: true, headers: covered },
    connectedAddress: '203.0.114.7',
  };
}

function transport(answer: (r: PolicySocketRequest) => UcpFetchResult) {
  const sent: PolicySocketRequest[] = [];
  const t = new UcpTransport({
    signer: () => ({ keyid: IDENTITY.key.jwk.kid, sign: IDENTITY.key.sign }),
    fetch: async (r) => {
      sent.push(r);
      return answer(r);
    },
  });
  return { t, sent };
}

const keysOf = (...jwks: object[]): MerchantKeys['keyFor'] =>
  merchantKeyLookup({ keys: jwks } as unknown as MerchantProfile);

const restCall = (keys?: MerchantKeys) => ({
  transport: 'rest' as const,
  endpoint: 'https://shop.example/ucp',
  profileUrl: PROFILE,
  operation: 'create_cart' as const,
  idempotencyKey: '7f1c0c1e-3a5e-4c0e-9d5f-1d1b2a3c4d5e',
  payload: { line_items: [] },
  ...(keys !== undefined ? { keys } : {}),
});

describe('requests', () => {
  it('every request is signed with the node’s key over the required components, at TLS 1.3 (MCP posts too)', async () => {
    const { t, sent } = transport(() => ({ ok: false, error: 'connect_failed', sent: false }));
    await t.call(restCall());
    await t.call({
      transport: 'mcp',
      endpoint: 'https://shop.example/mcp',
      profileUrl: PROFILE,
      operation: 'search_catalog',
      payload: { query: 'tea' },
    });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const r of sent) {
      expect(r.minTls).toBe('TLSv1.3');
      const msg: HttpMessage = {
        method: r.method,
        url: r.url,
        headers: r.headers,
        ...(r.body !== undefined ? { body: r.body } : {}),
      };
      expect(
        verifyMessage({ msg, required: requiredRequestComponents(msg), keyFor: DINA_KEYS, sha256 }),
      ).toMatchObject({
        ok: true,
        keyid: IDENTITY.key.jwk.kid,
      });
    }
    // The create covers its idempotency key and body.
    expect(sent[0]?.headers['signature-input']).toMatch(
      /"idempotency-key".*"content-digest"|"content-digest".*"idempotency-key"/,
    );
  });

  it('a signer whose key went away (a sealed phone) sends nothing at all, never an unsigned request', async () => {
    const sent: PolicySocketRequest[] = [];
    let signs = 0;
    const t = new UcpTransport({
      // Present for the MCP session's start, gone by the call itself.
      signer: () =>
        signs++ === 0 ? { keyid: IDENTITY.key.jwk.kid, sign: IDENTITY.key.sign } : null,
      fetch: async (r) => {
        sent.push(r);
        return {
          ok: true,
          status: 405,
          bodyBytes: new Uint8Array(),
          headers: {},
          connectedAddress: '203.0.114.7',
        } as UcpFetchResult;
      },
    });
    expect(
      await t.call({
        transport: 'mcp',
        endpoint: 'https://shop.example/mcp',
        profileUrl: PROFILE,
        operation: 'create_cart',
        idempotencyKey: '7f1c0c1e-3a5e-4c0e-9d5f-1d1b2a3c4d5e',
        payload: { line_items: [] },
      }),
    ).toEqual({ ok: false, kind: 'network', error: 'no_identity', sent: false });
    // Only the signed initialize left; the call did not.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['signature']).toBeDefined();
  });

  it('an MCP state change carries its idempotency key as a signed header too, the same as in its meta; reads and the session’s start do not', async () => {
    const { t, sent } = transport((r) =>
      r.body !== undefined && new TextDecoder().decode(r.body).includes('"initialize"')
        ? ({
            ok: true,
            status: 405,
            bodyBytes: new Uint8Array(),
            headers: {},
            connectedAddress: '203.0.114.7',
          } as UcpFetchResult)
        : { ok: false, error: 'connect_failed', sent: false },
    );
    const key = '7f1c0c1e-3a5e-4c0e-9d5f-1d1b2a3c4d5e';
    await t.call({
      transport: 'mcp',
      endpoint: 'https://shop.example/mcp',
      profileUrl: PROFILE,
      operation: 'create_cart',
      idempotencyKey: key,
      payload: { line_items: [] },
    });
    await t.call({
      transport: 'mcp',
      endpoint: 'https://shop.example/mcp',
      profileUrl: PROFILE,
      operation: 'search_catalog',
      payload: { query: 'tea' },
    });
    const posts = sent.map((r) => ({
      method: JSON.parse(new TextDecoder().decode(r.body)) as {
        method: string;
        params?: { name?: string; arguments?: { meta?: Record<string, unknown> } };
      },
      headers: r.headers,
    }));
    const create = posts.find((p) => p.method.params?.name === 'create_cart');
    expect(create?.headers['idempotency-key']).toBe(key);
    expect(create?.method.params?.arguments?.meta?.['idempotency-key']).toBe(key);
    expect(create?.headers['signature-input']).toContain('"idempotency-key"');
    for (const p of posts.filter((x) => x.method.params?.name !== 'create_cart'))
      expect(p.headers['idempotency-key']).toBeUndefined();
  });
});

describe('merchant keys', () => {
  it('come from the root profile and a version leaf; a kid both list is the root’s (the merchant’s own)', () => {
    const root = merchantKey('k-root');
    const leaf = merchantKey('k-leaf');
    const rootBoth = merchantKey('k-both');
    const leafBoth = merchantKey('k-both');
    const lookup = merchantKeyLookup(
      { keys: [root.jwk, rootBoth.jwk] } as unknown as MerchantProfile,
      { keys: [leaf.jwk, leafBoth.jwk] } as unknown as MerchantProfile,
    );
    const base = new TextEncoder().encode('base');
    const verifies = (kid: string, secret: Uint8Array) =>
      lookup(kid)?.verify(base, p256.sign(base, secret)) ?? false;
    expect(verifies('k-root', root.secret)).toBe(true);
    expect(verifies('k-leaf', leaf.secret)).toBe(true);
    expect(verifies('k-both', rootBoth.secret)).toBe(true);
    expect(verifies('k-both', leafBoth.secret)).toBe(false);
    expect(lookup('k-other')).toBeNull();
  });
});

describe('answers', () => {
  const key = merchantKey();
  const keys = (
    keyFor = keysOf(key.jwk),
    refresh: MerchantKeys['refresh'] = async () => null,
  ): MerchantKeys => ({
    keyFor,
    refresh,
  });
  const body = '{"ucp":{"version":"2026-08-25"},"id":"c1","line_items":[]}';

  it('an unsigned answer is accepted on the TLS connection', async () => {
    const { t } = transport(() => ({
      ok: true,
      status: 201,
      bodyBytes: new TextEncoder().encode(body),
      headers: { 'content-type': 'application/json' },
      connectedAddress: '203.0.114.7',
    }));
    expect(await t.call(restCall(keys()))).toMatchObject({ ok: true });
  });

  it('a signed answer that verifies is accepted, whichever half of s the signer used', async () => {
    let answer = signedAnswer(key, body);
    const { t } = transport(() => answer);
    expect(await t.call(restCall(keys()))).toMatchObject({ ok: true });
    // The same signature with s replaced by n - s (high-S): still a valid ECDSA signature.
    const sig = Buffer.from(
      String(answer.ok ? answer.headers.signature : '').slice(6, -1),
      'base64',
    );
    const n = p256.Point.CURVE().n;
    const s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
    const flipped = Buffer.concat([
      sig.subarray(0, 32),
      Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex'),
    ]);
    if (answer.ok)
      answer = {
        ...answer,
        headers: { ...answer.headers, signature: `sig1=:${flipped.toString('base64')}:` },
      };
    expect(await t.call(restCall(keys()))).toMatchObject({ ok: true });
  });

  it('an altered body, too little coverage, or a covered header that did not arrive is a lost answer, not a result', async () => {
    for (const answer of [
      signedAnswer(
        key,
        body,
        undefined,
        '{"ucp":{"version":"2026-08-25"},"id":"c2","line_items":[]}',
      ),
      signedAnswer(key, body, ['@status']),
      {
        ...(signedAnswer(key, body) as UcpFetchResult & { ok: true }),
        signedHeaders: { ok: false as const, reason: 'missing' as const },
      },
    ]) {
      const { t } = transport(() => answer);
      expect(await t.call(restCall(keys()))).toEqual({
        ok: false,
        kind: 'network',
        error: 'signature_invalid',
        sent: true,
      });
    }
  });

  it('a key the profile does not list: the profile is read again once; then it verifies, or fails', async () => {
    const rotated = merchantKey('rotated-key');
    const answer = signedAnswer(rotated, body);
    let refreshes = 0;
    const { t } = transport(() => answer);
    expect(
      await t.call(
        restCall(
          keys(keysOf(key.jwk), async () => {
            refreshes += 1;
            return keysOf(key.jwk, rotated.jwk);
          }),
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(refreshes).toBe(1);
    // A refresh not allowed now (or failed): refused.
    expect(await t.call(restCall(keys(keysOf(key.jwk))))).toMatchObject({
      ok: false,
      error: 'signature_invalid',
    });
  });

  it('a signed answer with no keys to check it against is refused', async () => {
    const { t } = transport(() => signedAnswer(key, body));
    expect(await t.call(restCall())).toMatchObject({ ok: false, error: 'signature_invalid' });
  });
});

describe('an answer whose signature headers were too large (dual review R1-5)', () => {
  afterEach(() => setUcpPolicySocket(null));

  it('fails as a bad signature through the real fetch, never passing as unsigned', async () => {
    const huge = 'x'.repeat(4097);
    setUcpPolicySocket(async () => ({
      ok: true,
      status: 200,
      bodyBytes: new TextEncoder().encode('{"ucp":{"version":"2026-08-25"},"id":"c1"}'),
      rawHeaders: [
        ['content-type', 'application/json'],
        ['signature', huge],
        ['signature-input', huge],
      ],
      connectedAddress: '203.0.114.7',
    }));
    // The real ucpFetch (no fetch override), so header narrowing is the production path.
    const t = new UcpTransport({
      signer: () => ({ keyid: IDENTITY.key.jwk.kid, sign: IDENTITY.key.sign }),
    });
    const merchant = merchantKey();
    const out = await t.call(restCall({ keyFor: keysOf(merchant.jwk) } as unknown as MerchantKeys));
    expect(out).toMatchObject({ ok: false });
    expect(JSON.stringify(out)).toMatch(/signature/);
  });
});
