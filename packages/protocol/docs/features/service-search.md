# Feature: service search (services AppView)

**What it is.** The wire contract for `com.dinakernel.service.search`, the
xRPC endpoint that ranks `com.dinakernel.service.profile` records by
capability, distance, text relevance, and operator trust. Federated
AppView implementations indexing the same firehose MUST produce
identical responses; otherwise users on different Dinas see
different providers for the same query.

This doc is the source-of-truth for: ranking formula, filter
semantics, capability normalization, cursor envelope, and response
shape. Changes here are wire-format changes — bump the version
tags accordingly (`rankingVersion` for formula, cursor `v` for
pagination shape).

## Request

```
GET /xrpc/com.dinakernel.service.search
    ?capability=<string, 1..200>          (required)
    [&lat=<number, -90..90>]              (optional)
    [&lng=<number, -180..180>]            (optional)
    [&radiusKm=<number, 0.1..500>]        (default 5)
    [&q=<string, 0..200>]                 (optional)
    [&limit=<integer, 1..50>]             (default 10)
    [&cursor=<base64url string>]          (optional)
```

`lat` and `lng` are independently optional but must be supplied
together — implementations either run in geospatial mode (distance
contributes to ranking, distance filter applies) or in text+trust-only
mode. A request with `lat` but no `lng` is ill-formed at the lexicon
layer.

## Response

```
{
  "services": [ServiceSearchResult, ...],
  "cursor": string | null,
  "rankingVersion": string
}
```

### `ServiceSearchResult`

```
{
  "uri": "at://<did>/com.dinakernel.service.profile/<rkey>",
  "operatorDid": "did:plc:...",
  "name": string,
  "description": string | null,
  "capabilities": string[],
  "capabilitySchemas": { [capability: string]: SchemaEntry } | null,
  "serviceArea": { lat: number, lng: number, radiusKm: number } | null,
  "hours": object | null,
  "responsePolicy": { [capability: string]: "auto" | "review" },
  "trustScore": number | null,            // [0, 1] from PeerLens
  "score": number,                        // composite ranking score
  "tombstoned": false,                    // always false in this endpoint

  // Flat convenience fields keyed by the requested capability:
  "matchedCapability": string,            // same as request `capability` after normalization
  "matchedSchema": SchemaEntry | null,
  "matchedSchemaHash": string | null,     // hex-64 SHA-256, null if no schema published
  "distanceKm": number | null             // null in text+trust-only mode
}
```

where `SchemaEntry` is:

```
{
  "description": string,
  "params": object,                       // JSON schema for params
  "result": object,                       // JSON schema for result
  "schema_hash": string                   // hex-64 SHA-256 of canonical schema
}
```

Field-name convention is camelCase across the response. The
`capabilitySchemas` nested objects retain their atproto record
field names (`schema_hash` snake_case) because they're stored
verbatim from the operator's published record.

## Capability normalization

The `capability` request parameter and every capability stored in
`services.capabilities_json` undergo the same fold:

1. **Trim** leading/trailing whitespace.
2. **Lowercase** (locale-independent — use no-argument
   `String.prototype.toLowerCase()` semantics).
3. (Storage only) **Deduplicate** within the array.
4. (Storage only) **Drop empty strings** after trim.

Without this symmetric fold, an operator publishing `"Plumbing"`
and a user searching for `"plumbing"` would miss each other.

## Filter semantics

The result set is intersected by every gate. A row is included
only when all are true:

1. **Operator discoverability** — `is_discoverable = true`. Operator-
   controlled; flipped via re-publish of the service.profile record.
2. **Not moderator-tombstoned** — `tombstoned_at IS NULL`. Operator-
   side gate set by the AppView admin surface; preserves the row
   for audit while excluding from active reads.
3. **Operator not redacted** — no row in `did_redactions` for the
   operator DID. GDPR-shaped exclusion; the service profile stays
   in the table for reversibility but never surfaces to readers.
4. **Capability match** — `capabilities_json @> [normalized_capability]`.
5. **(geospatial mode only) lat/lng present + within radiusKm** of
   the request location.

## Ranking formula

`rankingVersion = "v1"`.

```
score = distance_score * 0.4 + text_score * 0.3 + trust_score * 0.3   (geospatial mode)
score = text_score * 0.5 + trust_score * 0.5                          (text+trust-only mode)
```

- `distance_score = clamp(1.0 - haversine_km / radiusKm, 0, 1)`. Haversine
  uses Postgres `acos`; treat radii in km.
- `text_score = 1.0 if services.search_content ILIKE %q%, else 0.0`. The
  caller's `q` MUST be pattern-escaped (`%`, `_`, `\` prefixed with `\`)
  before wrapping; without this, a `q` containing `%` collapses to a
  match-everything pattern. Phase 2 will swap in `tsvector` for graded
  relevance — that bump moves `rankingVersion` to `v2`.
- `trust_score = COALESCE(did_profiles.overall_trust_score, 0.0)`.
  Already in `[0, 1]` from PeerLens; used without further scaling.

Sort: `score_bucket DESC, uri DESC` where
`score_bucket = floor(score * 1000)`. The integer bucket gives
stable ordering across float-precision wobbles in the haversine
calculation.

## Cursor envelope

```
cursor = base64url(JSON.stringify({ v: 1, bucket: <int>, uri: <string> }))
```

- `v` — cursor format version. `1` today. Bump for any structural
  change so old cursors decode against the correct envelope.
- `bucket` — the `score_bucket` of the last row in the previous
  page.
- `uri` — the at:// URI of the last row in the previous page,
  used as the tie-breaker within the same bucket.

Pagination is keyset-style on `(score_bucket DESC, uri DESC)`:

```
WHERE (score_bucket < cursor.bucket)
   OR (score_bucket = cursor.bucket AND uri < cursor.uri)
```

A malformed cursor (bad base64url, missing field, unknown `v`) MUST
be rejected with `InvalidRequest` rather than silently producing an
unconstrained page. `cursor` in the response is `null` when there's
no next page.

## Server-side projections

Two values are computed in the SELECT (not the WHERE) and surfaced
on each result so clients don't recompute them:

- `distanceKm` — same haversine formula as the distance score, but
  in raw km rather than scaled. `null` when no caller location was
  supplied.
- `matchedSchema` + `matchedSchemaHash` — picked out of
  `capabilitySchemas` by the (normalized) request capability. `null`
  when the operator's profile doesn't publish a schema for that
  capability.

## Error responses

Follows the AppView-wide contract in
[`appview/docs/API_ERRORS.md`](../../../../appview/docs/API_ERRORS.md):
`{ error: "<PascalName>", message: string }`. Known codes for
service-search:

- `InvalidRequest` — bad params (cursor decode failure, out-of-range
  lat/lng, oversized fields).
- `InternalServerError` — handler exception.

## Source of truth

- Code: [`appview/src/api/xrpc/service-search.ts`](../../../../appview/src/api/xrpc/service-search.ts)
  — handler, ranking, cursor encode/decode.
- Indexer: [`appview/src/ingester/handlers/service-profile.ts`](../../../../appview/src/ingester/handlers/service-profile.ts)
  — capability normalization, transactional re-index, three-timestamp model.
- Lexicon: `serviceProfileSchema` in
  [`appview/src/ingester/record-validator.ts`](../../../../appview/src/ingester/record-validator.ts)
  — closed `responsePolicy` enum, `schema_hash` hex regex.
- Tests: [`appview/tests/unit/service_search.test.ts`](../../../../appview/tests/unit/service_search.test.ts)
  + [`appview/tests/unit/service_profile_handler.test.ts`](../../../../appview/tests/unit/service_profile_handler.test.ts)
  serve as reference vectors until the cross-language conformance
  suite (`packages/protocol/conformance/`) is extended to cover
  AppView.

## Vectors

> _To be lifted into `conformance/vectors/service_search.json` when
> the cross-language conformance harness is extended to cover
> AppView. For now, the TS test inputs/outputs in
> `service_search.test.ts` are the reference vectors._

## Field stability

The following identifiers are part of the public contract and MUST
NOT be renamed or repurposed without a wire-format bump:

- Top-level response fields: `services`, `cursor`, `rankingVersion`.
- Per-result fields: every field listed under `ServiceSearchResult`
  above.
- `matchedCapability` is always the normalized form (lowercased,
  trimmed) — not the caller's original input.

Reserved for future use (do NOT repurpose):

- Per-result: `tombstoned: true` (today always `false`; will surface
  when an `includeTombstoned` variant ships).
- Top-level: `total` (returning the total candidate count for
  out-of-band UX).
