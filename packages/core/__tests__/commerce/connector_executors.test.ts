/**
 * What the broker actually does for a networked connector (§8.3, §10.3 — WS-9.1).
 *
 * The rule with teeth here is the second one in the module note: a credential
 * must not cross an origin. `fetchUnderPolicy` follows redirects and re-checks
 * each hop's URL, so a redirect to another PUBLIC host passes every check the
 * policy makes — and would have carried the supplier's ERP token with it. That
 * is the failure this suite exists for; the rest is scaffolding around it.
 */

import { SPREADSHEET_CONTENT_TYPES } from '../../src/commerce/catalog_feed_policy';
import {
  endpointsFromSupplierSettings,
  makeConnectorExecutors,
  sameOrigin,
  type AuthedTransport,
  type ConnectorEndpoint,
} from '../../src/commerce/connector_executors';

import type { FeedResponse } from '../../src/commerce/catalog_ingest';
import type { SupplierSettings } from '../../src/commerce/commerce_settings';

const SECRET = 'sk-live-erp-token-0123456789abcd';

interface Call {
  url: string;
  headers: Record<string, string>;
  request?: { method: string; contentType: string; body: string };
}

/** A scripted transport that records what it was asked to send. */
function scripted(responses: Record<string, Partial<FeedResponse>>): {
  transport: AuthedTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: AuthedTransport = async (url, headers, request) => {
    calls.push({ url, headers, ...(request === undefined ? {} : { request }) });
    const scripted = responses[url];
    if (scripted === undefined) throw new Error(`no scripted response for ${url}`);
    return {
      status: 200,
      contentType: 'application/json',
      connectedAddress: '93.184.216.34',
      body: '[]',
      compressedBytes: 2,
      decompressedBytes: 2,
      ...scripted,
    };
  };
  return { transport, calls };
}

const JSON_ENDPOINT: ConnectorEndpoint = {
  url: 'https://erp.example.com/catalog',
  auth: { kind: 'bearer' },
  json: true,
};

function executorFor(endpoint: ConnectorEndpoint, transport: AuthedTransport) {
  const table = makeConnectorExecutors({
    endpoints: () => ({ 'erp.primary:read_catalog': endpoint }),
    transport,
  })();
  const executor = table['erp.primary:read_catalog'];
  if (executor === undefined) throw new Error('the executor table lost its only entry');
  return executor;
}

describe('the credential never crosses an origin (§10.3)', () => {
  it('attaches the credential on the configured origin', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': { body: '[{"sku":"A"}]' },
    });
    const result = await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(result).toEqual({ ok: true, result: [{ sku: 'A' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
  });

  it('withholds it on a redirect to another host', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': {
        status: 302,
        location: 'https://cdn.example.net/catalog',
      },
      'https://cdn.example.net/catalog': { body: '[{"sku":"A"}]' },
    });
    const result = await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
    // THE WHOLE POINT. `cdn.example.net` is a legal public host, so every URL
    // check the policy makes passes; only this rule stops the token.
    expect(calls[1]?.headers).toEqual({});
  });

  it('keeps it across a redirect that stays on the same origin', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': {
        status: 301,
        location: 'https://erp.example.com/catalog/v2',
      },
      'https://erp.example.com/catalog/v2': { body: '[]' },
    });
    await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(calls[1]?.headers).toEqual({ authorization: `Bearer ${SECRET}` });
  });

  it('treats a lookalike hostname as a different origin', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': {
        status: 302,
        location: 'https://erp.example.com.evil.test/catalog',
      },
      'https://erp.example.com.evil.test/catalog': { body: '[]' },
    });
    await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    // A prefix comparison would have called this the same origin, and handed
    // `evil.test` the token.
    expect(calls[1]?.headers).toEqual({});
  });

  it('treats a different port as a different origin', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': {
        status: 302,
        location: 'https://erp.example.com:8443/catalog',
      },
      'https://erp.example.com:8443/catalog': { body: '[]' },
    });
    await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(calls[1]?.headers).toEqual({});
  });

  it('never puts the credential in the URL', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': { body: '[]' },
    });
    await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    for (const call of calls) expect(call.url).not.toContain(SECRET);
  });

  it('sends a named header when that is how the endpoint authenticates', async () => {
    const { transport, calls } = scripted({ 'https://erp.example.com/catalog': { body: '[]' } });
    await executorFor(
      { ...JSON_ENDPOINT, auth: { kind: 'header', name: 'X-Api-Key' } },
      transport,
    )({ secret: SECRET, params: {} });
    // Lower-cased, because a transport that sent both `X-Api-Key` and
    // `x-api-key` on a redirect-retry would be sending the credential twice.
    expect(calls[0]?.headers).toEqual({ 'x-api-key': SECRET });
  });

  it('sends nothing when the endpoint is public', async () => {
    const { transport, calls } = scripted({ 'https://erp.example.com/catalog': { body: '[]' } });
    await executorFor(
      { ...JSON_ENDPOINT, auth: { kind: 'none' } },
      transport,
    )({
      secret: SECRET,
      params: {},
    });
    expect(calls[0]?.headers).toEqual({});
  });
});

describe('sameOrigin, driven directly', () => {
  // The fetch policy refuses a malformed URL before the transport sees it, so
  // no path through an executor reaches the unparseable branch. It is still
  // the branch that decides whether a credential travels, and the direction it
  // fails in is the reason it exists — so it is checked here rather than left
  // to a redirect that cannot happen.
  it('withholds when either side will not parse', () => {
    expect(sameOrigin('not a url', 'https://erp.example.com/x')).toBe(false);
    expect(sameOrigin('https://erp.example.com/x', 'not a url')).toBe(false);
    expect(sameOrigin('', '')).toBe(false);
  });

  it('ignores the path, the query and the fragment', () => {
    expect(sameOrigin('https://erp.example.com/a?b=1#c', 'https://erp.example.com/z')).toBe(true);
  });

  it('separates schemes', () => {
    expect(sameOrigin('http://erp.example.com/x', 'https://erp.example.com/x')).toBe(false);
  });

  it('treats the default port and the explicit one as the same origin', () => {
    // `https://a.com` and `https://a.com:443` are the same server, and the URL
    // parser normalises the explicit port away. Withholding on that would
    // break a legal endpoint for no gain.
    expect(sameOrigin('https://erp.example.com:443/x', 'https://erp.example.com/x')).toBe(true);
  });
});

describe('the fetch policy still owns the request', () => {
  it('refuses a plaintext endpoint before any request is made', async () => {
    const { transport, calls } = scripted({});
    const result = await executorFor(
      { ...JSON_ENDPOINT, url: 'http://erp.example.com/catalog' },
      transport,
    )({ secret: SECRET, params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not_https');
    // Nothing was sent, so the credential never existed on the wire.
    expect(calls).toEqual([]);
  });

  it('refuses an endpoint that resolved to a blocked address', async () => {
    const { transport } = scripted({
      'https://erp.example.com/catalog': { connectedAddress: '127.0.0.1' },
    });
    const result = await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('blocked_connected_address');
  });

  it('refuses a spreadsheet backend serving JSON, and a JSON one serving CSV', async () => {
    const asCsv = scripted({
      'https://erp.example.com/catalog': { contentType: 'application/json', body: 'a,b' },
    });
    const csvResult = await executorFor(
      { ...JSON_ENDPOINT, json: false },
      asCsv.transport,
    )({
      secret: SECRET,
      params: {},
    });
    expect(csvResult.ok).toBe(false);
    if (!csvResult.ok) expect(csvResult.error).toContain('content_type_refused');

    const asJson = scripted({
      'https://erp.example.com/catalog': { contentType: 'text/csv', body: 'a,b' },
    });
    const jsonResult = await executorFor(
      JSON_ENDPOINT,
      asJson.transport,
    )({
      secret: SECRET,
      params: {},
    });
    expect(jsonResult.ok).toBe(false);
    if (!jsonResult.ok) expect(jsonResult.error).toContain('content_type_refused');
  });

  it('accepts every media type a spreadsheet exporter actually serves', async () => {
    for (const contentType of SPREADSHEET_CONTENT_TYPES) {
      const { transport } = scripted({
        'https://erp.example.com/catalog': { contentType, body: 'sku\nA' },
      });
      const result = await executorFor(
        { ...JSON_ENDPOINT, json: false },
        transport,
      )({
        secret: SECRET,
        params: {},
      });
      expect(result).toEqual({ ok: true, result: 'sku\nA' });
    }
  });

  it('reports a non-JSON answer as a failure rather than throwing', async () => {
    const { transport } = scripted({
      'https://erp.example.com/catalog': { body: 'not json at all' },
    });
    const result = await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not JSON');
  });
});

describe('endpoints come from the owner, and are read per call', () => {
  const settings = (
    connectors: SupplierSettings['connectors'],
  ): { ok: true; settings: SupplierSettings } => ({
    ok: true,
    settings: {
      actingBusinessDid: 'did:plc:chairmaker',
      catalogSource: { kind: 'feed', lastHealthyAtIso: null },
      publicRegions: [],
      publishIndicativePrice: false,
      quoteAccess: 'anyone',
      responsePolicy: {},
      customerPricingSource: null,
      orderAcceptance: 'review',
      listingState: 'live',
      connectors,
    },
  });

  it('derives the table key from the connector name and its operation', () => {
    const endpoints = endpointsFromSupplierSettings(() =>
      settings([
        {
          name: 'erp.primary',
          healthy: true,
          credentialValid: true,
          lastCheckedAtIso: null,
          endpoint: {
            operation: 'read_catalog',
            url: 'https://erp.example.com/catalog',
            auth: 'bearer',
            json: true,
          },
        },
      ]),
    );
    expect(Object.keys(endpoints())).toEqual(['erp.primary:read_catalog']);
    expect(endpoints()['erp.primary:read_catalog']).toEqual({
      url: 'https://erp.example.com/catalog',
      auth: { kind: 'bearer' },
      json: true,
    });
  });

  it('yields nothing when the settings row does not validate', () => {
    // FAIL CLOSED. A row this build cannot interpret must not be used to decide
    // where a credential is sent.
    const endpoints = endpointsFromSupplierSettings(() => ({ ok: false }));
    expect(endpoints()).toEqual({});
  });

  it('skips a connector that declares no endpoint', () => {
    const endpoints = endpointsFromSupplierSettings(() =>
      settings([
        { name: 'local.csv', healthy: true, credentialValid: true, lastCheckedAtIso: null },
      ]),
    );
    expect(endpoints()).toEqual({});
  });

  it('reflects a connector added after the table was built', () => {
    let connectors: SupplierSettings['connectors'] = [];
    const table = makeConnectorExecutors({
      endpoints: endpointsFromSupplierSettings(() => settings(connectors)),
      transport: scripted({}).transport,
    });
    expect(Object.keys(table())).toEqual([]);

    connectors = [
      {
        name: 'erp.primary',
        healthy: true,
        credentialValid: true,
        lastCheckedAtIso: null,
        endpoint: {
          operation: 'read_catalog',
          url: 'https://erp.example.com/catalog',
          auth: 'bearer',
          json: true,
        },
      },
    ];
    // A table captured at boot would still be empty here, and every brokered
    // call would refuse `no_executor` until the process restarted.
    expect(Object.keys(table())).toEqual(['erp.primary:read_catalog']);
  });
});

/**
 * §24 — an ERP that does not answer a GET (WS-9.2).
 *
 * Every real ERP RPC carries a body: Odoo speaks JSON-RPC over POST, a
 * NetSuite RESTlet takes a POST body, an OData function import the same. The
 * executor could only GET, so the connector lane could read a spreadsheet and
 * almost nothing a business actually runs on. This is the shape of a real
 * Odoo `call_kw` — the same request the live demo takes, driven against a
 * scripted server because a public demo instance is not a dependency a test
 * suite may have.
 */
describe('an RPC connector (§24)', () => {
  const ODOO_URL = 'https://erp.example.com/jsonrpc';
  const ODOO_BODY = JSON.stringify({
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: ['demo', 2, 'token', 'product.product', 'search_read', [[]], { fields: ['name'] }],
    },
    id: 1,
  });

  const ODOO_ENDPOINT: ConnectorEndpoint = {
    url: ODOO_URL,
    auth: { kind: 'header', name: 'X-Api-Key' },
    json: true,
    request: { method: 'POST', contentType: 'application/json', body: ODOO_BODY },
  };

  it('sends the configured body and credential, and returns the answer', async () => {
    const { transport, calls } = scripted({
      [ODOO_URL]: { body: '{"jsonrpc":"2.0","id":1,"result":[{"name":"Oak chair"}]}' },
    });
    const executors = makeConnectorExecutors({
      endpoints: () => ({ 'erp:read_catalog': ODOO_ENDPOINT }),
      transport,
    })();
    const outcome = await (executors['erp:read_catalog'] as NonNullable<
      (typeof executors)['erp:read_catalog']
    >)({ secret: SECRET, params: undefined });

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual({
      method: 'POST',
      contentType: 'application/json',
      body: ODOO_BODY,
    });
    // The credential rides a HEADER, never the URL — rule 3.
    // LOWERCASED by `authHeaders`. HTTP header names are case-insensitive, and
    // normalising is what stops a config that says `X-Api-Key` and one that
    // says `x-api-key` producing two headers on one request.
    expect(calls[0]?.headers['x-api-key']).toBe(SECRET);
    expect(calls[0]?.url).toBe(ODOO_URL);
    expect(calls[0]?.url).not.toContain(SECRET);
  });

  it('REFUSES to follow a redirect on a request with a body', async () => {
    // The hazard that decided this design. Replaying the body at the new
    // location sends a supplier's query — and on a same-origin hop its
    // credential — to a host the operator never configured, and a redirect is
    // exactly how an attacker picks that host. Following as a GET instead
    // (what a browser does to a 301 POST) silently drops the body and returns
    // something unrelated, which this node would record as the ERP's answer.
    const { transport, calls } = scripted({
      [ODOO_URL]: {
        status: 302,
        location: 'https://erp-mirror.example.com/jsonrpc',
      },
    });
    const executors = makeConnectorExecutors({
      endpoints: () => ({ 'erp:read_catalog': ODOO_ENDPOINT }),
      transport,
    })();
    const outcome = await (executors['erp:read_catalog'] as NonNullable<
      (typeof executors)['erp:read_catalog']
    >)({ secret: SECRET, params: undefined });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/must not be redirected/);
    // ONE call. The second host was never contacted at all, so the body and
    // the credential never left the configured origin.
    expect(calls).toHaveLength(1);
  });

  it('leaves a GET connector exactly as it was', async () => {
    // The whole point of an optional body: every existing connector keeps its
    // behaviour, including following a legal redirect.
    const { transport, calls } = scripted({
      'https://erp.example.com/catalog': { body: '[]' },
    });
    const executors = makeConnectorExecutors({
      endpoints: () => ({ 'erp:read_catalog': JSON_ENDPOINT }),
      transport,
    })();
    await (executors['erp:read_catalog'] as NonNullable<
      (typeof executors)['erp:read_catalog']
    >)({ secret: SECRET, params: undefined });
    expect(calls[0]?.request).toBeUndefined();
  });
});

/**
 * §24 / WS-9.2 — a real ERP does not answer a bare list.
 *
 * Odoo's JSON-RPC replies `{jsonrpc, id, result: [...]}`, and `recordsFrom`
 * refuses anything that is not an array or `{items: [...]}` — on purpose,
 * because guessing which field holds the catalog is how a connector silently
 * publishes a page of metadata as products. `rowsAt` is the owner DECLARING
 * the field instead.
 */
describe('a wrapped ERP answer (§24 — Odoo JSON-RPC)', () => {
  const ODOO: ConnectorEndpoint = {
    url: 'https://erp.example.com/jsonrpc',
    auth: { kind: 'bearer' },
    json: true,
    rowsAt: 'result',
    request: {
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service: 'object', method: 'execute_kw' },
      }),
    },
  };

  it('hands back the declared field, so the rows reach the importer', async () => {
    const { transport } = scripted({
      'https://erp.example.com/jsonrpc': {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: [{ default_code: 'CHAIR-OAK', name: 'Oak dining chair', list_price: 500 }],
        }),
      },
    });

    const result = await executorFor(ODOO, transport)({ secret: SECRET, params: {} });
    expect(result.ok).toBe(true);
    // The ENVELOPE is gone; what remains is what a catalog reader expects.
    expect(result.ok && result.result).toEqual([
      { default_code: 'CHAIR-OAK', name: 'Oak dining chair', list_price: 500 },
    ]);
  });

  it('does not fall back to the envelope when the declared field is absent', async () => {
    // A JSON-RPC ERROR answer carries no `result`. Degrading to "try the top
    // level" would hand the importer an object, and reading it as an empty
    // catalog would publish a withdrawal of every product the supplier sells.
    const { transport } = scripted({
      'https://erp.example.com/jsonrpc': {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: 200, message: 'Odoo Server Error' },
        }),
      },
    });

    const result = await executorFor(ODOO, transport)({ secret: SECRET, params: {} });
    // The executor succeeded — the HTTP call worked — and handed back nothing
    // a row reader can use, which `loadCatalogThroughConnector` refuses as
    // `not_a_row_list` rather than importing.
    expect(result.ok && result.result).toBeUndefined();
  });

  it('leaves an unwrapped REST answer alone', async () => {
    const { transport } = scripted({
      'https://erp.example.com/catalog': {
        body: JSON.stringify([{ sku: 'CHAIR-OAK' }]),
      },
    });
    const result = await executorFor(JSON_ENDPOINT, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([{ sku: 'CHAIR-OAK' }]);
  });

  it('carries the RPC body and the credential to the ERP', async () => {
    const { transport, calls } = scripted({
      'https://erp.example.com/jsonrpc': {
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }),
      },
    });
    await executorFor(ODOO, transport)({ secret: SECRET, params: {} });
    expect(calls[0]?.request?.method).toBe('POST');
    expect(calls[0]?.request?.contentType).toBe('application/json');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  });
});

/**
 * §24 / WS-9.2 — an ERP does not speak the catalog's vocabulary.
 *
 * Odoo's `product.product` answers `default_code`, `name`, `barcode` and a
 * major-unit float `list_price`. The importer wants `identifier`, `title`,
 * `gtin` and integer `list_price_minor_units`, and it is STRICT — an
 * unrecognised column raises `unknown_column` rather than being dropped. So the
 * rename and the money conversion happen here, from an owner's declaration.
 */
describe('projecting an ERP row onto catalog columns (§24)', () => {
  const ODOO_MAPPED: ConnectorEndpoint = {
    url: 'https://erp.example.com/jsonrpc',
    auth: { kind: 'bearer' },
    json: true,
    rowsAt: 'result',
    fieldMap: { identifier: 'default_code', title: 'name', gtin: 'barcode' },
    price: { field: 'list_price', currency: 'INR', decimals: 2 },
  };

  const answer = (rows: unknown[]): Record<string, Partial<FeedResponse>> => ({
    'https://erp.example.com/jsonrpc': {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: rows }),
    },
  });

  it('renames the declared fields and leaves the rest alone', async () => {
    const { transport } = scripted(
      answer([{ default_code: 'CHAIR-OAK', name: 'Oak dining chair', barcode: '05012345678900' }]),
    );
    const result = await executorFor(ODOO_MAPPED, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([
      { identifier: 'CHAIR-OAK', title: 'Oak dining chair', gtin: '05012345678900' },
    ]);
  });

  it('turns a major-unit price into integer minor units with its currency', async () => {
    // §9.1 — no float ever reaches an amount. 500.0 INR is 50000 paise.
    const { transport } = scripted(answer([{ default_code: 'CHAIR-OAK', list_price: 500.0 }]));
    const result = await executorFor(ODOO_MAPPED, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([
      { identifier: 'CHAIR-OAK', list_price_minor_units: '50000', currency: 'INR' },
    ]);
  });

  it('rounds rather than truncates a price with more precision than the currency', async () => {
    // Truncating 12.345 to 1234 undercharges every line of every order.
    const { transport } = scripted(answer([{ list_price: 12.345 }]));
    const result = await executorFor(ODOO_MAPPED, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([
      { list_price_minor_units: '1235', currency: 'INR' },
    ]);
  });

  it('DROPS a price that is not a number rather than publishing a zero', async () => {
    // Odoo answers `false` for an unset field. Coercing that to 0 would put a
    // free chair in a public catalog.
    const { transport } = scripted(answer([{ default_code: 'CHAIR-OAK', list_price: false }]));
    const result = await executorFor(ODOO_MAPPED, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([{ identifier: 'CHAIR-OAK' }]);
  });

  it('passes an unmapped field through, so the importer still names it', async () => {
    // Hiding it here would decide on the supplier's behalf that a column they
    // believe they published does not exist.
    const { transport } = scripted(answer([{ default_code: 'CHAIR-OAK', qty_available: 12 }]));
    const result = await executorFor(ODOO_MAPPED, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([{ identifier: 'CHAIR-OAK', qty_available: 12 }]);
  });

  it('leaves rows untouched when the owner declared no projection', async () => {
    const { transport } = scripted(answer([{ default_code: 'CHAIR-OAK', list_price: 500 }]));
    const plain: ConnectorEndpoint = { ...ODOO_MAPPED };
    delete plain.fieldMap;
    delete plain.price;
    const result = await executorFor(plain, transport)({ secret: SECRET, params: {} });
    expect(result.ok && result.result).toEqual([{ default_code: 'CHAIR-OAK', list_price: 500 }]);
  });
});
