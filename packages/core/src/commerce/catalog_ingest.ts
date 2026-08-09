/**
 * Catalog feed ingest (§10.2, §10.3) — the consumer half.
 *
 * This is where the wire contract and the fetch policy stop being libraries
 * and become a pipeline nobody can route around:
 *
 *   1. every hop goes through `catalog_feed_policy` — scheme, credentials,
 *      literal address, redirect target, connected address, content type,
 *      byte cap, decompression bounds;
 *   2. every record goes through `@dina/commerce-protocol` — pointer advance,
 *      snapshot commitments, per-page proof.
 *
 * WHY THE POLICY LIVES INSIDE THE INGESTER RATHER THAN BESIDE IT. A transport
 * that took a URL and returned bytes would let a caller fetch first and ask
 * questions after — and the interesting failure is exactly the request that
 * should never have been made. So the transport injected here is DUMB: it is
 * handed a URL the ingester has already cleared, and it reports back what it
 * actually connected to so the ingester can check that too.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never trusts the feed host for
 * anything but bytes. Content decides nothing: the supplier's records say what
 * the catalog is, the digests say whether these are those records, and a feed
 * that serves something else fails verification rather than being indexed.
 */

import {
  verifyCatalogPage,
  verifyCatalogPointerAdvance,
  verifyCatalogSnapshot,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import {
  CATALOG_FEED_LIMITS,
  checkCatalogFeedContentType,
  checkCatalogFeedDecompression,
  checkCatalogFeedRedirect,
  checkCatalogFeedUrl,
  isBlockedAddress,
} from './catalog_feed_policy';

/**
 * What a transport reports back. `connectedAddress` is not decoration: it is
 * the only defence against a name that resolved differently at connect time
 * than at validation, and the ingester refuses without it.
 */
export interface FeedResponse {
  status: number;
  contentType: string | null;
  /** The address actually connected to, for the re-check. */
  connectedAddress: string;
  /** Redirect target, when the status is a redirect. */
  location?: string;
  body: string;
  compressedBytes: number;
  decompressedBytes: number;
}

/**
 * A request with a BODY (§24 — WS-9.2).
 *
 * Most ERPs are not fetchable. Odoo speaks JSON-RPC over POST, NetSuite
 * RESTlets take a POST body, SAP OData function imports the same; a connector
 * that can only GET can read a spreadsheet and almost nothing a business
 * actually runs on.
 *
 * `method` is deliberately not a free string. Every verb this lane could grow
 * — PUT, PATCH, DELETE — is a WRITE to a supplier's system of record, and the
 * connector lane is a READ lane (§8.3: the broker performs operations the
 * owner declared, and the declared ones fetch). Adding a verb should be a
 * decision somebody argues for, not a value somebody passes.
 */
export interface FeedRequestBody {
  method: 'POST';
  contentType: string;
  body: string;
}

export type FeedTransport = (
  url: string,
  /** Absent for a GET. Present exactly when this fetch carries a body. */
  request?: FeedRequestBody,
) => Promise<FeedResponse>;

let feedTransport: FeedTransport | null = null;

/**
 * Install how this node FETCHES a supplier's catalog feed (§10.2, WS-5.1).
 *
 * A REGISTRY, not a route parameter, and the reason is the one that kept
 * `ingestCatalog` on the orphan ledger: Core makes no outbound HTTP, and a
 * route that constructed a fetch would put egress behind an owner endpoint
 * where the gates cannot see it. The composition root owns transport; it
 * installs one here and Core stays the thing that VERIFIES what comes back.
 *
 * Null is not a degraded mode. A node with no transport cannot ingest, and
 * says so, rather than reaching for a global `fetch`.
 */
export function installCatalogFeedTransport(value: FeedTransport | null): void {
  feedTransport = value;
}

export function getCatalogFeedTransport(): FeedTransport | null {
  return feedTransport;
}

/**
 * The running cost of ONE ingest, threaded through every fetch.
 *
 * Per-response caps bound a single document; only a shared budget bounds the
 * whole operation. A snapshot may legitimately name a thousand pages, so
 * "each page is under 8MB" is not a limit on anything an attacker cares about.
 */
export interface IngestBudget {
  startedAt: number;
  bytesUsed: number;
}

export type IngestRefusal =
  | 'url_refused'
  | 'budget_bytes_exhausted'
  | 'budget_time_exhausted'
  | 'redirect_refused'
  | 'blocked_connected_address'
  | 'bad_status'
  | 'content_type_refused'
  | 'too_large'
  | 'decompression_refused'
  | 'body_unreadable'
  | 'pointer_refused'
  | 'snapshot_refused'
  | 'page_refused'
  | 'page_count_mismatch';

export type IngestResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: IngestRefusal; error: string };

function refuse<T>(refusal: IngestRefusal, error: string): IngestResult<T> {
  return { ok: false, refusal, error };
}

/**
 * Fetch one document under the full §10.3 policy, following redirects.
 *
 * Every hop is re-validated, because a redirect is a second chance to reach a
 * blocked address and the first URL being clean says nothing about the second.
 */
export async function fetchUnderPolicy(
  url: string,
  transport: FeedTransport,
  budget?: IngestBudget,
  now: () => number = () => Date.now(),
  /**
   * Media types this fetch will accept (WS-9.1).
   *
   * Defaulted to the FEED set, so every existing caller keeps the behaviour it
   * had. The spreadsheet connector passes the CSV set instead: one fetch
   * policy, two document kinds, and no allow-list widened for a caller that
   * does not need it.
   */
  allowedContentTypes?: ReadonlySet<string>,
  /**
   * A request body, for the RPC-style endpoints §24's ERP connector needs.
   *
   * Absent is a GET and behaves exactly as before, which is why every existing
   * caller is untouched.
   */
  request?: FeedRequestBody,
): Promise<IngestResult<string>> {
  const initial = checkCatalogFeedUrl(url);
  if (initial !== null) return refuse('url_refused', `catalog feed: ${initial}`);

  let current = url;
  for (let hop = 0; hop <= CATALOG_FEED_LIMITS.maxRedirects; hop += 1) {
    // Checked BEFORE each request, so an ingest that has already run long
    // stops rather than starting one more call it cannot afford.
    if (budget !== undefined && now() - budget.startedAt > CATALOG_FEED_LIMITS.maxMillis) {
      return refuse('budget_time_exhausted', 'catalog feed: ingest exceeded its time budget');
    }
    const response = await transport(current, request);

    // The connected address is checked on EVERY hop. A name that validated as
    // public can resolve to metadata by the time the socket opens.
    if (isBlockedAddress(response.connectedAddress)) {
      return refuse(
        'blocked_connected_address',
        `catalog feed: connected to a blocked address (${response.connectedAddress})`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      // A REQUEST WITH A BODY DOES NOT FOLLOW REDIRECTS. Three options, and
      // two of them are wrong:
      //
      //   - Replay the body at the new location. That sends a supplier's
      //     query — and, on the hop where origins match, its credential — to
      //     a host the operator never configured. This is the same hazard the
      //     credential rule in `connector_executors.ts` exists for, and a
      //     redirect is precisely how an attacker chooses the destination.
      //   - Follow as a GET, which is what browsers do to a 301/302 POST.
      //     The body silently vanishes and the endpoint answers something
      //     unrelated, which this node would then treat as the ERP's answer.
      //
      // So it refuses and says why. An endpoint that redirects its RPC path
      // is an endpoint whose URL the operator should correct, once, rather
      // than one this node quietly guesses about on every call.
      if (request !== undefined) {
        return refuse(
          'redirect_refused',
          'catalog feed: an endpoint with a request body must not be redirected — configure the final URL',
        );
      }
      const target = response.location ?? '';
      const verdict = checkCatalogFeedRedirect(target, hop);
      if (verdict !== null) return refuse('redirect_refused', `catalog feed: ${verdict}`);
      current = target;
      continue;
    }

    if (response.status !== 200) {
      return refuse('bad_status', `catalog feed: HTTP ${String(response.status)}`);
    }
    if (!checkCatalogFeedContentType(response.contentType, allowedContentTypes)) {
      return refuse(
        'content_type_refused',
        `catalog feed: unexpected content type ${response.contentType ?? '(none)'}`,
      );
    }
    if (response.compressedBytes > CATALOG_FEED_LIMITS.maxBytes) {
      return refuse('too_large', 'catalog feed: response exceeds the byte cap');
    }
    if (budget !== undefined) {
      budget.bytesUsed += response.compressedBytes;
      if (budget.bytesUsed > CATALOG_FEED_LIMITS.maxTotalBytes) {
        return refuse('budget_bytes_exhausted', 'catalog feed: ingest exceeded its byte budget');
      }
    }
    const bomb = checkCatalogFeedDecompression(
      response.compressedBytes,
      response.decompressedBytes,
    );
    if (bomb !== null) return refuse('decompression_refused', `catalog feed: ${bomb}`);

    return { ok: true, value: response.body };
  }
  // The loop bound and the policy's hop cap agree, so this is only reachable
  // if a transport kept redirecting; treat it as the same refusal.
  return refuse('redirect_refused', 'catalog feed: too_many_redirects');
}

function parseJson<T>(body: string): IngestResult<T> {
  try {
    return { ok: true, value: JSON.parse(body) as T };
  } catch (error) {
    return refuse(
      'body_unreadable',
      `catalog feed: body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface IngestedCatalog {
  pointer: CatalogPointer;
  snapshot: CatalogSnapshot;
  /** Items in payload order, flattened across pages. */
  items: unknown[];
}

/**
 * Ingest a publication: verify the pointer advance, fetch and verify the
 * snapshot, then fetch and verify every page in order.
 *
 * `previousPointer` is what this consumer last accepted from this supplier.
 * Passing it is what makes gaps and rollbacks visible — an ingester that
 * always passed null would accept a replayed old catalog as current.
 */
export async function ingestCatalog(args: {
  pointer: CatalogPointer;
  previousPointer: CatalogPointer | null;
  snapshotUrl: string;
  /** Page URL by index, so a feed layout stays the caller's business. */
  pageUrl: (index: number) => string;
  transport: FeedTransport;
  sha256: Sha256Fn;
  /** Injected so the budget is testable without real time passing. */
  now?: () => number;
}): Promise<IngestResult<IngestedCatalog>> {
  const now = args.now ?? ((): number => Date.now());
  // ONE budget for the whole ingest — the snapshot and every page share it.
  const budget: IngestBudget = { startedAt: now(), bytesUsed: 0 };
  const advance = verifyCatalogPointerAdvance(args.previousPointer, args.pointer);
  if (advance !== null) return refuse('pointer_refused', advance);

  // A withdrawal publishes no snapshot, so there is nothing to fetch. The
  // tombstone IS the result — a consumer learns the catalog is retired.
  if (args.pointer.withdrawn === true) {
    return refuse('snapshot_refused', 'catalog feed: this catalog was withdrawn');
  }

  const snapshotBody = await fetchUnderPolicy(args.snapshotUrl, args.transport, budget, now);
  if (!snapshotBody.ok) return snapshotBody;
  const parsedSnapshot = parseJson<CatalogSnapshot>(snapshotBody.value);
  if (!parsedSnapshot.ok) return parsedSnapshot;
  const snapshot = parsedSnapshot.value;

  const snapshotVerdict = verifyCatalogSnapshot(snapshot, args.sha256);
  if (snapshotVerdict !== null) return refuse('snapshot_refused', snapshotVerdict);

  // The POINTER is the authority for which snapshot is current. A feed that
  // serves a different (even internally valid) snapshot is substituting one
  // publication for another, which is the attack the pointer exists to stop.
  if (snapshot.snapshot_digest !== args.pointer.snapshot_digest) {
    return refuse('snapshot_refused', 'catalog feed: snapshot is not the one the pointer names');
  }

  const items: unknown[] = [];
  for (let index = 0; index < snapshot.page_digests.length; index += 1) {
    const pageBody = await fetchUnderPolicy(args.pageUrl(index), args.transport, budget, now);
    if (!pageBody.ok) return pageBody;
    const parsedPage = parseJson<CatalogSnapshotPage>(pageBody.value);
    if (!parsedPage.ok) return parsedPage;

    const verdict = verifyCatalogPage(parsedPage.value, snapshot, args.sha256);
    if (verdict !== null) return refuse('page_refused', verdict);
    // Position is checked explicitly as well as through the digest: a feed
    // that served page 3 for every index would otherwise be caught only by
    // the digest comparison, and the clearer refusal is worth the line.
    if (parsedPage.value.page_index !== index) {
      return refuse('page_count_mismatch', 'catalog feed: page served for the wrong index');
    }
    items.push(...parsedPage.value.items);
  }

  if (items.length !== snapshot.item_count) {
    // The snapshot's own count disagreeing with what the pages hold means the
    // publication is internally inconsistent, even though every page verified.
    return refuse(
      'page_count_mismatch',
      `catalog feed: pages hold ${String(items.length)} items, snapshot claims ${String(snapshot.item_count)}`,
    );
  }

  return { ok: true, value: { pointer: args.pointer, snapshot, items } };
}
