import { SPREADSHEET_CONTENT_TYPES } from './catalog_feed_policy';
import { fetchUnderPolicy, type FeedRequestBody, type FeedResponse } from './catalog_ingest';

import type { SupplierSettings } from './commerce_settings';
import type { BrokeredExecutor } from './credential_broker';

/**
 * What the credential broker actually DOES for a networked connector
 * (§8.3, §10.3 — WS-9.1 / WS-9.3).
 *
 * The broker owns the secret and the authorization; this owns the request. It
 * is the only place in the codebase where a credential and a URL meet, which
 * is why three rules live here rather than in whichever composition root
 * happened to wire a connector:
 *
 *   1. EVERY FETCH GOES THROUGH THE §10.3 POLICY. Scheme, literal address,
 *      redirect target, connected address, content type and byte caps are
 *      already written and already tested; a connector fetch that skipped them
 *      would be a second outbound path with none of the defences of the first.
 *
 *   2. THE CREDENTIAL NEVER CROSSES AN ORIGIN. `fetchUnderPolicy` follows
 *      redirects and re-checks each hop, but a legal redirect to another host
 *      is still another host. The header is attached only when the hop's
 *      origin matches the configured endpoint's, so a supplier's ERP token
 *      cannot be redirected onto somebody else's server. This is the failure
 *      that motivated the whole check: the URL policy would have permitted it.
 *
 *   3. THE CREDENTIAL NEVER TOUCHES THE URL. There is no query-parameter auth
 *      option, deliberately: a query string reaches proxy logs, referrer
 *      headers and browser history, and offering the option is how somebody
 *      picks it.
 *
 * Core still owns no transport. One is injected, and it is dumb: it is handed
 * a URL this module has already cleared and headers it must send verbatim.
 */

/** How a credential is presented to an endpoint. Headers only — see rule 3. */
export type ConnectorAuth =
  | { kind: 'bearer' }
  | { kind: 'header'; name: string }
  /** A public endpoint. Legal, and different from a missing credential. */
  | { kind: 'none' };

export interface ConnectorEndpoint {
  /** Absolute URL. Re-validated by the feed policy before any request. */
  url: string;
  auth: ConnectorAuth;
  /** True when the answer is JSON to be parsed, false for CSV text. */
  json: boolean;
  /**
   * §24 — an RPC endpoint's request body.
   *
   * Absent is a GET, which is every connector that reads a file or a REST
   * collection. Present is the shape an ERP actually speaks: Odoo's JSON-RPC,
   * a NetSuite RESTlet, an OData function import.
   *
   * The body is CONFIGURATION, fixed by the owner when they set the connector
   * up — not something a caller passes per request. That is the whole reason
   * this lane stays safe to expose: a brokered call cannot choose what to ask
   * an ERP, only whether to ask. Letting a caller supply the body would turn a
   * read connector into an arbitrary RPC channel into a supplier's system of
   * record, with the owner's credential attached.
   */
  request?: FeedRequestBody;
  /**
   * §24 — the response field the rows live under, when the answer is wrapped.
   *
   * Odoo's JSON-RPC does not answer a list; it answers
   * `{jsonrpc, id, result: [...]}`. So does every other RPC-shaped ERP, each
   * under its own field name. `recordsFrom` accepts a bare array or
   * `{items: [...]}` and REFUSES the rest on purpose — guessing which field
   * holds the catalog is how a connector silently publishes a page of metadata
   * as products.
   *
   * This is the owner DECLARING the field rather than the code guessing it. A
   * single field name, never a path: a dotted expression is a small query
   * language, and a query language over a supplier's response is a second way
   * to decide what a catalog is.
   */
  rowsAt?: string;
  /**
   * §24 — how THIS backend's field names map onto catalog columns.
   *
   * An ERP does not speak the catalog's vocabulary. Odoo's `product.product`
   * answers `default_code`, `name`, `barcode`, `list_price`; the importer wants
   * `identifier`, `title`, `gtin`, `list_price_minor_units`. The importer is
   * strict on purpose — an unrecognised column raises `unknown_column` rather
   * than being dropped, because a column silently ignored is a column the
   * supplier believes they published — so the rename has to happen before it.
   *
   * Target column → source field. A RENAME and nothing else: no expressions,
   * no defaults, no concatenation. Every one of those is a step toward a
   * transformation language sitting between a supplier's system of record and
   * what the world is told they sell.
   */
  fieldMap?: Record<string, string>;
  /**
   * §24 — the one field a rename cannot carry: money.
   *
   * ERPs quote a major-unit decimal (`list_price: 500.0`) and the catalog
   * carries integer minor units (§9.1 — no float ever reaches an amount). Three
   * named values, not a formula: which field holds the price, what currency it
   * is in, and how many decimal places that currency's major unit has.
   *
   * The currency is CONFIGURATION rather than a mapped column because an ERP
   * that answers a bare number has not said which currency it means, and
   * guessing that is how a catalog gets published at a hundredth of its price.
   */
  price?: { field: string; currency: string; decimals: number };
}

/** A transport that sends the headers it is given, and nothing else. */
export type AuthedTransport = (
  url: string,
  headers: Record<string, string>,
  /** Absent for a GET. The transport must send this verbatim. */
  request?: FeedRequestBody,
) => Promise<FeedResponse>;

/**
 * Same scheme, host and port.
 *
 * Compared through the URL parser rather than by string prefix: `https://a.com`
 * and `https://a.com.evil.net` share a prefix, and a prefix check is how that
 * becomes a credential sent to `evil.net`. An unparseable URL is NOT the same
 * origin as anything, which fails toward withholding the credential.
 *
 * EXPORTED SO IT CAN BE TESTED DIRECTLY, not because anything else calls it.
 * The unparseable case is defence in depth — the fetch policy refuses a
 * malformed URL before the transport sees it, so no path through
 * `makeExecutor` reaches that branch. A rule nothing can reach is a rule
 * nothing can check, and the direction it fails in is the whole point of
 * having it.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.protocol === right.protocol &&
      left.hostname === right.hostname &&
      left.port === right.port
    );
  } catch {
    return false;
  }
}

function authHeaders(auth: ConnectorAuth, secret: string): Record<string, string> {
  switch (auth.kind) {
    case 'bearer':
      return { authorization: `Bearer ${secret}` };
    case 'header':
      return { [auth.name.toLowerCase()]: secret };
    case 'none':
      return {};
  }
}

/**
 * Build the broker's executor table from configured endpoints.
 *
 * Returns a THUNK, and the broker calls it per request. An owner may add or
 * repoint a connector while the node runs; a table captured at boot would
 * answer `no_executor` for every connector configured after the process
 * started, and keep calling the endpoint they replaced.
 */
export function makeConnectorExecutors(args: {
  /** `${resource}:${operation}` → where that operation goes. */
  endpoints: () => Record<string, ConnectorEndpoint>;
  transport: AuthedTransport;
  now?: () => number;
}): () => Record<string, BrokeredExecutor> {
  return () => {
    const table: Record<string, BrokeredExecutor> = {};
    for (const [key, endpoint] of Object.entries(args.endpoints())) {
      table[key] = makeExecutor(endpoint, args.transport, args.now);
    }
    return table;
  };
}

/**
 * The endpoints an owner has configured, read from supplier settings.
 *
 * ONE derivation, shared by both composition roots. The alternative — each
 * boot building its own map from the settings row — is the shape that lets a
 * server and a phone disagree about which operation reaches which URL, and the
 * disagreement would only show up as a connector that works on one of them.
 *
 * A settings row that does not validate yields NO endpoints, so every brokered
 * call refuses `no_executor`. That is the fail-closed reading: a settings row
 * this build cannot interpret must not be used to decide where a credential is
 * sent.
 */
export function endpointsFromSupplierSettings(
  readSupplier: () => { ok: true; settings: SupplierSettings } | { ok: false },
): () => Record<string, ConnectorEndpoint> {
  return () => {
    const read = readSupplier();
    if (!read.ok) return {};
    const table: Record<string, ConnectorEndpoint> = {};
    for (const connector of read.settings.connectors) {
      const endpoint = connector.endpoint;
      if (endpoint === undefined) continue;
      table[`${connector.name}:${endpoint.operation}`] = {
        url: endpoint.url,
        auth:
          endpoint.auth === 'header'
            ? { kind: 'header', name: endpoint.headerName ?? '' }
            : { kind: endpoint.auth },
        json: endpoint.json,
        ...((endpoint.rowsAt ?? '') === '' ? {} : { rowsAt: endpoint.rowsAt as string }),
        ...(endpoint.fieldMap === undefined ? {} : { fieldMap: endpoint.fieldMap }),
        ...(endpoint.price === undefined ? {} : { price: endpoint.price }),
        // Only when the owner configured BOTH halves — the settings validator
        // refuses one without the other, and reading them independently here
        // would let a row that failed validation still produce a request.
        ...((endpoint.requestBody ?? '') !== '' && (endpoint.requestContentType ?? '') !== ''
          ? {
              request: {
                method: 'POST' as const,
                contentType: endpoint.requestContentType as string,
                body: endpoint.requestBody as string,
              },
            }
          : {}),
      };
    }
    return table;
  };
}

function makeExecutor(
  endpoint: ConnectorEndpoint,
  transport: AuthedTransport,
  now?: () => number,
): BrokeredExecutor {
  return async ({ secret }) => {
    const headers = authHeaders(endpoint.auth, secret);
    // ONE closure, one origin. Every hop `fetchUnderPolicy` follows asks this
    // function for bytes, and only the hop that stayed on the configured
    // origin is given the credential.
    const authed = async (url: string, request?: FeedRequestBody): Promise<FeedResponse> =>
      transport(url, sameOrigin(url, endpoint.url) ? headers : {}, request);

    const fetched = await fetchUnderPolicy(
      endpoint.url,
      authed,
      undefined,
      now ?? ((): number => Date.now()),
      // A spreadsheet serves CSV and a REST endpoint serves JSON. Passing the
      // set that matches the parser means a backend serving the other kind is
      // refused at the fetch rather than at a confusing parse failure.
      endpoint.json ? undefined : SPREADSHEET_CONTENT_TYPES,
      // §24: the RPC body, when this connector is one. Threaded through the
      // policy rather than around it, so an RPC endpoint gets the same scheme,
      // address, redirect, content-type and byte checks a feed URL does.
      endpoint.request,
    );
    if (!fetched.ok) {
      // The policy's own refusal, verbatim. It names the rule that stopped the
      // request (a blocked address, a redirect, a content type), which is what
      // an owner needs; none of those strings can carry the credential,
      // because the policy never saw it.
      return { ok: false, error: `${fetched.refusal}: ${fetched.error}` };
    }
    if (!endpoint.json) return { ok: true, result: fetched.value };
    try {
      const parsed = JSON.parse(fetched.value) as unknown;
      // UNWRAPPED HERE, in the one place that knows this endpoint's shape.
      // Doing it downstream would mean handing the envelope to a reader that
      // has to work out which field to trust.
      return { ok: true, result: projectRows(unwrapRows(parsed, endpoint.rowsAt), endpoint) };
    } catch (error) {
      return {
        ok: false,
        error: `the endpoint answered something that is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

/**
 * Take the declared field out of a wrapped answer.
 *
 * FAIL LOUD, NOT SILENTLY THROUGH. When `rowsAt` is declared and the field is
 * absent, this returns the field's own (undefined) value rather than the whole
 * envelope — so the caller refuses `not_a_row_list` and names the connector.
 * Returning the envelope instead would let a declared-but-missing field
 * degrade into "try the top level", which is the guessing this exists to
 * avoid.
 *
 * A JSON-RPC ERROR answer is caught by the same rule: Odoo replies
 * `{jsonrpc, id, error: {...}}` with no `result`, and an unwrap of an absent
 * field is a refusal rather than an empty catalog. An empty catalog would
 * publish a withdrawal of every product the supplier sells.
 */
function unwrapRows(parsed: unknown, rowsAt: string | undefined): unknown {
  if (rowsAt === undefined || rowsAt === '') return parsed;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return (parsed as Record<string, unknown>)[rowsAt];
}

/**
 * Rename an ERP's fields onto catalog columns, and turn its price into minor
 * units (§24).
 *
 * NOT A GUESS ANYWHERE. Only fields the owner named are renamed; a source
 * field the mapping does not mention is passed through untouched, so the
 * importer still raises `unknown_column` for it rather than this function
 * deciding what to hide. A price field that is not a finite number is DROPPED
 * rather than coerced — a catalog row with no price is refused downstream,
 * where a row priced at zero would be published.
 *
 * A non-array answer passes straight through, because "these are not rows" is
 * the caller's refusal to make and it names the connector when it does.
 */
function projectRows(rows: unknown, endpoint: ConnectorEndpoint): unknown {
  const map = endpoint.fieldMap;
  const price = endpoint.price;
  if ((map === undefined || Object.keys(map).length === 0) && price === undefined) return rows;
  if (!Array.isArray(rows)) return rows;

  // Inverted once, not per row: source field → target column.
  const rename = new Map<string, string>();
  for (const [target, source] of Object.entries(map ?? {})) rename.set(source, target);

  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
    const source = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (price !== undefined && key === price.field) continue; // handled below
      out[rename.get(key) ?? key] = value;
    }
    if (price !== undefined) {
      const minor = toMinorUnits(source[price.field], price.decimals);
      if (minor !== null) {
        out.list_price_minor_units = minor;
        out.currency = price.currency;
      }
    }
    return out;
  });
}

/**
 * A major-unit amount as integer minor units, or null when it is not a number.
 *
 * Rounded, not truncated: an ERP that answers `12.345` for a 2-decimal
 * currency has more precision than the currency has, and truncating would
 * silently undercharge every line. Rounding half away from zero matches what a
 * person reading the ERP screen would write down.
 */
function toMinorUnits(value: unknown, decimals: number): string | null {
  // NOT `Number(value)`. Odoo answers `false` for an unset field, and
  // `Number(false)` is 0 — as are `Number(null)` and `Number('')`. Every one of
  // those would publish a free product. A number is a number, or a string that
  // is entirely one; nothing else is a price.
  let amount: number;
  if (typeof value === 'number') {
    amount = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    amount = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(amount)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) return null;
  const scaled = amount * Math.pow(10, decimals);
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return String(rounded);
}
