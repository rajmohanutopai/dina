import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { CAP } from '../src/capabilities';
import { es256PublicJwk, es256Thumbprint, usableEs256Keys } from '../src/jwk';
import { chooseVersion, checkLeaf, filterProfile, intersectCapabilities } from '../src/negotiate';
import { buyerProfileBytes, parseMerchantProfile, type MerchantProfile } from '../src/profile';

import { must } from './helpers';

const V = '2026-08-25';
const s = (p: string) => `https://ucp.dev/${V}/schemas/shopping/${p}.json`;

/** A merchant profile shaped like Allbirds' (MCP only, Shopify extension, permalink). */
function shopifyLike(over: Record<string, unknown> = {}): unknown {
  return {
    ucp: {
      version: V,
      supported_versions: { '2026-04-08': 'https://shop.example/.well-known/ucp/2026-04-08' },
      services: {
        'dev.ucp.shopping': [
          {
            version: V,
            transport: 'mcp',
            endpoint: 'https://shop.example/api/ucp/mcp',
            schema: `https://ucp.dev/${V}/services/shopping/mcp.openrpc.json`,
          },
          {
            version: '2026-04-08',
            transport: 'embedded',
            schema: 'https://ucp.dev/2026-04-08/services/shopping/embedded.openrpc.json',
          },
        ],
      },
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: V, schema: s('checkout') }],
        'dev.ucp.shopping.fulfillment': [
          { version: V, schema: s('fulfillment'), extends: 'dev.ucp.shopping.checkout' },
        ],
        'dev.ucp.shopping.discount': [
          { version: V, schema: s('discount'), extends: 'dev.ucp.shopping.checkout' },
        ],
        'dev.ucp.shopping.cart': [{ version: V, schema: s('cart') }],
        'dev.ucp.shopping.order': [{ version: V, schema: s('order') }],
        'dev.ucp.shopping.catalog.search': [{ version: V, schema: s('catalog_search') }],
        'dev.ucp.shopping.catalog.lookup': [{ version: V, schema: s('catalog_lookup') }],
        'dev.ucp.shopping.permalink': [
          { version: V, schema: s('permalink'), config: { endpoint: 'https://shop.example/buy' } },
        ],
        'dev.shopify.catalog': [
          { version: '2026-01-01', schema: 'https://shopify.dev/ucp/schemas/catalog.json' },
        ],
      },
      payment_handlers: { 'com.google.pay': [{ id: 'g', version: '2026-01-11' }] },
      ...over,
    },
  };
}

function parse(value: unknown): MerchantProfile {
  const r = parseMerchantProfile(value);
  if (!r.ok) throw new Error(r.reason);
  return r.profile;
}

describe('parseMerchantProfile', () => {
  it('reads services, capabilities and supported_versions', () => {
    const p = parse(shopifyLike());
    expect(p.version).toBe(V);
    expect(p.supportedVersions).toEqual({
      '2026-04-08': 'https://shop.example/.well-known/ucp/2026-04-08',
    });
    expect(p.capabilities['dev.ucp.shopping.fulfillment']?.[0]?.extends).toEqual([
      'dev.ucp.shopping.checkout',
    ]);
  });
  it.each([
    ['no ucp', {}, 'no_ucp_object'],
    [
      'bad version',
      { ucp: { version: 'draft', services: {}, payment_handlers: {} } },
      'bad_version',
    ],
    ['no services', { ucp: { version: V, payment_handlers: {} } }, 'no_services'],
    ['no payment_handlers', { ucp: { version: V, services: {} } }, 'no_payment_handlers'],
  ])('refuses a profile with %s', (_n, value, reason) => {
    expect(parseMerchantProfile(value)).toEqual({ ok: false, reason });
  });
  it('drops an entry it cannot read, keeps the rest, and ignores unknown members', () => {
    const p = parse({
      ucp: {
        version: V,
        services: {},
        payment_handlers: {},
        future_member: { x: 1 },
        capabilities: {
          'dev.ucp.shopping.checkout': [{ version: V }, { version: V, schema: s('checkout') }],
          BAD: [],
        },
      },
    });
    expect(p.capabilities['dev.ucp.shopping.checkout']).toHaveLength(1);
    expect(p.capabilities['BAD']).toBeUndefined();
  });
});

describe('version choice', () => {
  it('uses the current profile when it is v2026-08-25', () => {
    expect(chooseVersion(parse(shopifyLike()))).toEqual({ kind: 'current' });
  });
  it('fetches the leaf when the merchant is newer but lists v2026-08-25', () => {
    const p = parse({
      ucp: {
        version: '2027-01-01',
        supported_versions: { [V]: 'https://s.example/.well-known/ucp/2026-08-25' },
        services: {},
        payment_handlers: {},
      },
    });
    expect(chooseVersion(p)).toEqual({
      kind: 'leaf',
      url: 'https://s.example/.well-known/ucp/2026-08-25',
    });
  });
  it('has no version for a v2026-04-08-only merchant (S20: offer the web page)', () => {
    const p = parse({ ucp: { version: '2026-04-08', services: {}, payment_handlers: {} } });
    expect(chooseVersion(p)).toEqual({ kind: 'none', offered: ['2026-04-08'] });
  });
  it('checks a leaf: its version must be ours and it must carry no supported_versions', () => {
    expect(checkLeaf(parse(shopifyLike({ supported_versions: undefined })))).toEqual({ ok: true });
    expect(checkLeaf(parse(shopifyLike()))).toEqual({
      ok: false,
      reason: 'leaf_has_supported_versions',
    });
    expect(
      checkLeaf(parse({ ucp: { version: '2026-04-08', services: {}, payment_handlers: {} } })),
    ).toEqual({
      ok: false,
      reason: 'leaf_version_mismatch',
    });
  });
});

describe('filtering', () => {
  it('keeps the MCP endpoint and drops the older embedded entry and unsupported transports', () => {
    const f = filterProfile(parse(shopifyLike()));
    expect(f.endpoints).toEqual({ mcp: 'https://shop.example/api/ucp/mcp' });
    expect(f.dropped).toContainEqual({ name: 'dev.ucp.shopping', reason: 'version_mismatch' });
  });
  it('drops a dev.ucp entry at another version, and an entry failing authority binding', () => {
    const f = filterProfile(
      parse(
        shopifyLike({
          capabilities: {
            'dev.ucp.shopping.checkout': [{ version: '2026-04-08', schema: s('checkout') }],
            'dev.ucp.shopping.cart': [{ version: V, schema: 'https://evil.example/cart.json' }],
            'dev.shopify.catalog': [
              { version: '2026-01-01', schema: 'https://shopify.dev/ucp/schemas/catalog.json' },
            ],
          },
        }),
      ),
    );
    expect(f.capabilities['dev.ucp.shopping.checkout']).toBeUndefined();
    expect(f.capabilities['dev.ucp.shopping.cart']).toBeUndefined();
    // A vendor extension versions independently and its schema host matches its name.
    expect(f.capabilities['dev.shopify.catalog']).toHaveLength(1);
    expect(f.dropped).toEqual(
      expect.arrayContaining([
        { name: 'dev.ucp.shopping.checkout', reason: 'version_mismatch' },
        { name: 'dev.ucp.shopping.cart', reason: 'authority' },
      ]),
    );
  });
  it('drops a service with no https endpoint and strips one trailing slash', () => {
    const f = filterProfile(
      parse(
        shopifyLike({
          services: {
            'dev.ucp.shopping': [
              { version: V, transport: 'rest', endpoint: 'http://shop.example/ucp' },
              { version: V, transport: 'mcp', endpoint: 'https://shop.example/mcp/' },
            ],
          },
        }),
      ),
    );
    expect(f.endpoints).toEqual({ mcp: 'https://shop.example/mcp' });
  });
});

describe('intersection', () => {
  it('keeps what both declare, never a vendor extension Dina does not declare', () => {
    const caps = intersectCapabilities(filterProfile(parse(shopifyLike())).capabilities);
    expect([...caps.keys()].sort()).toEqual(
      [
        CAP.cart,
        CAP.catalogLookup,
        CAP.catalogSearch,
        CAP.checkout,
        CAP.discount,
        CAP.fulfillment,
        CAP.order,
        CAP.permalink,
      ].sort(),
    );
    expect(caps.has('dev.shopify.catalog')).toBe(false);
  });
  it('prunes an extension whose parent is gone, until stable', () => {
    const caps = intersectCapabilities({
      [CAP.fulfillment]: [{ version: V, schema: s('fulfillment'), extends: [CAP.checkout] }],
      [CAP.discount]: [{ version: V, schema: s('discount'), extends: [CAP.checkout] }],
    });
    expect(caps.size).toBe(0);
  });
  it('keeps a multi-parent extension when one parent remains', () => {
    const caps = intersectCapabilities({
      [CAP.checkout]: [{ version: V, schema: s('checkout') }],
      [CAP.discount]: [{ version: V, schema: s('discount'), extends: [CAP.cart, CAP.checkout] }],
    });
    expect(caps.has(CAP.discount)).toBe(true);
  });
  it('needs an exact shared version string', () => {
    const caps = intersectCapabilities({
      [CAP.checkout]: [{ version: '2026-08-26', schema: s('checkout') }],
    });
    expect(caps.size).toBe(0);
  });
  it('declares identity linking only when asked', () => {
    const m = {
      [CAP.identityLinking]: [
        { version: V, schema: `https://ucp.dev/${V}/schemas/common/identity_linking.json` },
      ],
    };
    expect(intersectCapabilities(m).has(CAP.identityLinking)).toBe(false);
    expect(intersectCapabilities(m, { identityLinking: true }).has(CAP.identityLinking)).toBe(true);
  });
});

/** Dina's profile as the tests walk it. */
interface ProfileJson {
  version: string;
  payment_handlers: unknown;
  services: Record<string, { transport: string }[]>;
  capabilities: Record<string, { config?: unknown }[]>;
}

describe("Dina's buyer profile", () => {
  // RFC 9421 B.1.3 test key, as a P-256 point.
  const point = new Uint8Array([
    0x04,
    ...Buffer.from('qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA', 'base64url'),
    ...Buffer.from('Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0', 'base64url'),
  ]);
  const jwk = es256PublicJwk(point, sha256);
  const input = {
    keys: [jwk],
    webhookUrl: 'https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/webhooks/orders',
  };

  it('publishes a thumbprint kid (RFC 7638) and the key round-trips as usable', () => {
    expect(jwk.kid).toBe(es256Thumbprint(jwk.x, jwk.y, sha256));
    expect(usableEs256Keys([jwk])).toEqual([{ kid: jwk.kid, publicKey: point }]);
  });

  it('is a valid merchant-readable profile with no payment handlers, no AP2, no buyer_consent, and the webhook URL', () => {
    // Read back from the served bytes, as a merchant would.
    const profile = JSON.parse(buyerProfileBytes(input)) as { ucp: ProfileJson; keys: unknown[] };
    expect(profile.ucp.version).toBe(V);
    expect(profile.ucp.payment_handlers).toEqual({});
    const names = Object.keys(profile.ucp.capabilities);
    expect(names).not.toContain('dev.ucp.common.payment.ap2_mandate');
    expect(names).not.toContain('dev.ucp.shopping.buyer_consent');
    expect(names).not.toContain(CAP.identityLinking);
    expect(must(profile.ucp.capabilities[CAP.order])[0]?.config).toEqual({
      webhook_url: input.webhookUrl,
    });
    expect(must(profile.ucp.services['dev.ucp.shopping']).map((x) => x.transport)).toEqual([
      'mcp',
      'rest',
    ]);
    // Every declared capability passes authority binding, as a merchant SHOULD check.
    // (Dina's services carry no endpoint, as a platform's need not, so only
    // capabilities are filtered here.)
    const parsed = parse(profile);
    expect(filterProfile({ ...parsed, services: {} }).dropped).toEqual([]);
  });

  it('serves exact, frozen canonical bytes', () => {
    // The bytes the host hashes and serves, pinned for the RFC 9421 B.1.3 test key.
    // Checked independently: Python's sorted-key compact JSON of the same object
    // gives the same text, and the kid is the key's RFC 7638 thumbprint.
    const frozen = readFileSync(
      join(__dirname, 'fixtures', 'buyer_profile_rfc9421_key.json'),
      'utf8',
    ).trimEnd();
    expect(buyerProfileBytes(input)).toBe(frozen);
    expect(jwk.kid).toBe('ydQXMtvbsOsZyFir-Y7A8t7fKEM1gbKPvyFkdpu4fvI');
  });

  it('declares identity linking when asked', () => {
    const profile = JSON.parse(buyerProfileBytes({ ...input, identityLinking: true })) as {
      ucp: ProfileJson;
    };
    expect(profile.ucp.capabilities[CAP.identityLinking]).toHaveLength(1);
  });

  it('skips keys a verifier cannot use, without refusing the set', () => {
    expect(
      usableEs256Keys([
        { kid: 'ed', kty: 'OKP', crv: 'Ed25519', x: 'AAAA' },
        { ...jwk, use: 'enc' },
        { ...jwk, key_ops: ['sign'] },
        { ...jwk, d: 'secret' },
        { ...jwk, alg: 'ES384' },
        jwk,
      ]),
    ).toHaveLength(1);
  });
});
