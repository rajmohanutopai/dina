/**
 * Fake UCP merchants for Core's tests: each serves a profile offering catalog
 * search over MCP, the published v2026-08-25 schemas, and search answers built
 * from the spec's own product example.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { CAP, UCP_VERSION } from '@dina/ucp';

import { SPEC_EXAMPLES } from '../../../../ucp/__tests__/spec_fixture';
import { RELEASE_SCHEMAS } from '../../../src/commerce/ucp/schemas';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const DIR = path.join(__dirname, '../../../../ucp/__tests__/fixtures/schemas/2026-08-25');

/** The published release, by URL. */
export const RELEASE: Record<string, string> = {};
(function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else RELEASE[RELEASE_SCHEMAS + path.relative(DIR, p)] = readFileSync(p, 'utf8');
  }
})(DIR);

/** The spec's own search answer with a product (the response scaffold's list is empty). */
export const SEARCH_ANSWER = SPEC_EXAMPLES.find((e) => e.source === 'shopping/catalog/rest.md:104')
  ?.value as unknown as {
  ucp: Record<string, unknown>;
  products: Record<string, unknown>[];
};
const SAMPLE = SEARCH_ANSWER.products[0] as Record<string, unknown>;

/** The spec's product under another id and title. */
export const productNamed = (id: string, title: string): Record<string, unknown> => ({
  ...structuredClone(SAMPLE),
  id,
  title,
});

/**
 * The smallest product the published schemas accept: only the members they
 * require (`product.json`, `variant.json`), one variant. A near-cap answer is
 * thousands of these.
 */
export const smallProduct = (id: string): Record<string, unknown> => {
  const sample = SAMPLE as {
    price_range: unknown;
    variants: { price: unknown }[];
  };
  return {
    id,
    title: `t${id}`,
    description: { plain: 'd' },
    price_range: sample.price_range,
    variants: [
      { id: `${id}v`, title: 'v', description: { plain: 'd' }, price: sample.variants[0]?.price },
    ],
  };
};

/**
 * How a fake merchant answers a search: the products its function returns;
 * `down` (no connection); `hang` (connected, never answers); `no_ucp` (a web
 * server with no UCP profile); or an HTTP error status with an optional UCP
 * code.
 */
export type FakeShop =
  | (() => Record<string, unknown>[])
  | 'down'
  | 'hang'
  | 'no_ucp'
  | { status: number; code?: string };

/**
 * Merchants by origin. Answers over the request's byte cap fail as the
 * policy socket fails them (`too_large`).
 */
export function fakeMerchants(
  shops: Record<string, FakeShop>,
  options: {
    withoutLookup?: readonly string[];
    /** get_product for the shop's first product answered with its last one instead. */
    strayProduct?: readonly string[];
  } = {},
) {
  const asked: string[] = [];
  /** Every operation a merchant was asked, with the request body Dina sent. */
  const requests: { origin: string; operation: string; payload: Record<string, unknown> }[] = [];
  const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    const reply = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ): UcpFetchResult => {
      const bodyBytes = new TextEncoder().encode(
        typeof body === 'string' ? body : JSON.stringify(body),
      );
      if (bodyBytes.length > r.maxResponseBytes)
        return { ok: false, error: 'too_large', sent: true };
      return {
        ok: true,
        status,
        bodyBytes,
        headers: { 'content-type': 'application/json', ...headers },
        connectedAddress: '203.0.114.7',
      };
    };
    if (RELEASE[r.url] !== undefined) return reply(200, RELEASE[r.url]);
    const url = new URL(r.url);
    const shop = shops[url.origin];
    if (shop === undefined || shop === 'down')
      return { ok: false, error: 'connect_failed', sent: false };
    if (shop === 'no_ucp') return reply(404, { error: 'not found' });
    if (url.pathname === '/.well-known/ucp') {
      return reply(200, {
        ucp: {
          version: UCP_VERSION,
          services: {
            'dev.ucp.shopping': [
              { version: UCP_VERSION, transport: 'mcp', endpoint: `${url.origin}/mcp` },
            ],
          },
          capabilities: {
            [CAP.catalogSearch]: [
              { version: UCP_VERSION, schema: `${RELEASE_SCHEMAS}shopping/catalog_search.json` },
            ],
            ...(options.withoutLookup?.includes(url.origin)
              ? {}
              : {
                  [CAP.catalogLookup]: [
                    {
                      version: UCP_VERSION,
                      schema: `${RELEASE_SCHEMAS}shopping/catalog_lookup.json`,
                    },
                  ],
                }),
          },
          payment_handlers: {},
        },
      });
    }
    const msg = JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array()));
    if (msg.method === 'initialize')
      return reply(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25' } });
    if (msg.method === 'notifications/initialized') return reply(202, '');
    asked.push(url.origin);
    const operation = String(msg.params?.name ?? '');
    const payload = (msg.params?.arguments?.catalog ?? {}) as Record<string, unknown>;
    requests.push({ origin: url.origin, operation, payload });
    if (shop === 'hang') return new Promise<UcpFetchResult>(() => undefined);
    if (typeof shop !== 'function') {
      return reply(shop.status, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'refused', data: { code: shop.code ?? 'unknown' } },
      });
    }
    const answer = (structuredContent: Record<string, unknown>) =>
      reply(200, { jsonrpc: '2.0', id: msg.id, result: { structuredContent } });
    if (operation === 'lookup_catalog') {
      // Each product asked for by id, its variants marked as resolved from it (lookup_variant).
      const ids = new Set((payload.ids as string[] | undefined) ?? []);
      const products = shop()
        .filter((p) => ids.has(String(p.id)))
        .map((p) => ({
          ...p,
          variants: ((p.variants as Record<string, unknown>[]) ?? []).map((v) => ({
            ...v,
            inputs: [{ id: String(p.id), match: 'featured' }],
          })),
        }));
      return answer({ ucp: SEARCH_ANSWER.ucp, products });
    }
    if (operation === 'get_product') {
      const all = shop();
      const stray =
        options.strayProduct?.includes(url.origin) === true && payload.id === all[0]?.id;
      const product = stray ? all.at(-1) : all.find((p) => p.id === payload.id);
      // Not found is an application outcome, in the UCP envelope (catalog/lookup.md).
      if (product === undefined)
        return answer({
          ucp: { ...SEARCH_ANSWER.ucp, status: 'error' },
          messages: [
            {
              type: 'error',
              code: 'not_found',
              content: 'No such product.',
              severity: 'unrecoverable',
            },
          ],
        });
      return answer({ ucp: SEARCH_ANSWER.ucp, product });
    }
    return answer({ ...SEARCH_ANSWER, products: shop() });
  };
  // Every merchant here, as an owner who allows them all would list them.
  const origins = Object.keys(shops).sort();
  return { fetch, asked, requests, origins };
}
