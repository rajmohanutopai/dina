/**
 * `search_ucp_merchants` (UCP plan §3.15): the index's merchants read
 * strictly, kept in the index's trust order, usable ones only and none
 * PeerLens says to avoid, a reviewer's name cleaned, and a note that the
 * owner decides which shops Dina may use.
 */

import { AppViewClient, AppViewError, type UcpIndexMerchant } from '../../src/appview_client/http';
import { createSearchUcpMerchantsTool } from '../../src/reasoning/ucp_merchant_index_tool';

const merchant = (over: Record<string, unknown> = {}) => ({
  origin: 'https://tea.example',
  name: 'Tea House',
  state: 'usable',
  reason: null,
  version: '2026-08-25',
  transport: 'mcp',
  capabilities: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.checkout'],
  trustScore: 0.9,
  recommendation: 'proceed',
  reviewCount: 5,
  verified: true,
  checkedAt: '2026-10-05T10:00:00.000Z',
  ...over,
});

function clientAnswering(body: unknown): { client: AppViewClient; urls: string[] } {
  const urls: string[] = [];
  const client = new AppViewClient({
    appViewURL: 'https://appview.test',
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleepFn: async () => undefined,
  });
  return { client, urls };
}

describe('the client reads the index strictly', () => {
  it('passes the need and capability; drops entries of another shape; cleans a reviewer’s name', async () => {
    const { client, urls } = clientAnswering({
      merchants: [
        merchant({ name: 'Tea‮ House\u0000' }),
        merchant({ origin: 'http://plain.example' }),
        merchant({ origin: 'https://x.example', trustScore: 2 }),
        merchant({ origin: 'https://y.example', capabilities: ['evil'] }),
        merchant({ origin: 'https://z.example', recommendation: 'buy now' }),
        merchant({
          origin: 'https://ok.example',
          name: null,
          trustScore: null,
          verified: false,
          reviewCount: 0,
        }),
      ],
    });
    const got = await client.searchUcpMerchants({
      q: 'tea',
      capability: 'dev.ucp.shopping.checkout',
      limit: 5,
    });
    expect(got.map((m) => m.origin)).toEqual(['https://tea.example', 'https://ok.example']);
    expect(got[0]?.name).not.toMatch(/[‮\u0000]/);
    expect(got[1]).toMatchObject({ name: '', trustScore: null, verified: false });
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/xrpc/com.dinakernel.ucp.searchMerchants');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'tea',
      capability: 'dev.ucp.shopping.checkout',
      limit: '5',
    });
  });
});

describe('search_ucp_merchants', () => {
  const tool = (found: UcpIndexMerchant[] | Error, log: Record<string, unknown>[] = []) => {
    const asked: unknown[] = [];
    return {
      asked,
      tool: createSearchUcpMerchantsTool({
        appView: {
          searchUcpMerchants: async (p) => {
            asked.push(p);
            if (found instanceof Error) throw found;
            return found;
          },
        },
        logger: (e) => log.push(e),
      }),
    };
  };
  const m = (over: Partial<UcpIndexMerchant>): UcpIndexMerchant => ({
    origin: 'https://tea.example',
    name: 'Tea House',
    state: 'usable',
    capabilities: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.checkout'],
    trustScore: 0.9,
    recommendation: 'proceed',
    reviewCount: 5,
    verified: true,
    ...over,
  });

  it('keeps the index’s trust order; only usable shops, none to avoid; says what Dina can do there and that the owner decides', async () => {
    const log: Record<string, unknown>[] = [];
    const { tool: t, asked } = tool(
      [
        m({}),
        m({ origin: 'https://avoid.example', recommendation: 'avoid' }),
        m({
          origin: 'https://rice.example',
          name: 'Rice',
          trustScore: 0.4,
          capabilities: ['dev.ucp.shopping.checkout'],
        }),
        m({ origin: 'https://pending.example', state: 'pending' }),
        m({
          origin: 'https://new.example',
          name: '',
          verified: false,
          trustScore: null,
          reviewCount: 0,
          recommendation: 'verify',
        }),
      ],
      log,
    );
    const out = (await t.execute({ need: 'loose leaf tea', can: 'checkout' })) as {
      shops: Record<string, unknown>[];
      note: string;
    };
    expect(asked).toEqual([
      { q: 'loose leaf tea', capability: 'dev.ucp.shopping.checkout', limit: 25 },
    ]);
    expect(out.shops).toEqual([
      {
        shop: 'https://tea.example',
        name: 'Tea House',
        trust: { score: 0.9, recommendation: 'proceed', reviews: 5 },
        dina_can: ['search', 'checkout'],
      },
      {
        shop: 'https://rice.example',
        name: 'Rice',
        trust: { score: 0.4, recommendation: 'proceed', reviews: 5 },
        dina_can: ['checkout'],
      },
      { shop: 'https://new.example', trust: 'unverified', dina_can: ['search', 'checkout'] },
    ]);
    expect(out.note).toMatch(/Settings → Shopping/);
    // Named on PeerLens; an unverified one has no review: never "reviewed" for all of them.
    expect(out.note).not.toMatch(/were reviewed/);
    expect(out.note).toMatch(/never add one yourself/);
    // The log holds counts, never the need.
    expect(JSON.stringify(log)).not.toMatch(/tea/);
  });

  it('re-sorts by trust whatever order arrived', async () => {
    const out = (await tool([
      m({ origin: 'https://low.example', trustScore: 0.2 }),
      m({ origin: 'https://high.example', trustScore: 0.8 }),
    ]).tool.execute({})) as { shops: { shop: string }[] };
    expect(out.shops.map((x) => x.shop)).toEqual(['https://high.example', 'https://low.example']);
  });

  it('nothing found says so; the directory down says so; any other failure surfaces; an unknown capability asks for none', async () => {
    expect(await tool([]).tool.execute({ need: 'x' })).toMatchObject({
      status: 'ok',
      shops: [],
      note: expect.stringMatching(/do not invent/),
    });
    expect(await tool(new AppViewError('down', 503, '/x')).tool.execute({})).toMatchObject({
      status: 'unavailable',
    });
    expect(await tool(new AppViewError('net', null, '/x')).tool.execute({})).toMatchObject({
      status: 'unavailable',
    });
    await expect(
      tool(new AppViewError('Unknown method', 400, '/x')).tool.execute({}),
    ).rejects.toThrow('Unknown method');
    await expect(tool(new Error('bug')).tool.execute({})).rejects.toThrow('bug');
    const { tool: t, asked } = tool([]);
    await t.execute({ can: 'pay' });
    expect(asked).toEqual([{ limit: 25 }]);
  });
});
