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
      return { ok: true, result: JSON.parse(fetched.value) as unknown };
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
