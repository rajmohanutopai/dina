# Feature: subject_id (PeerLens / AppView)

**What it is.** The deterministic identifier the AppView mints for
every `SubjectRef` it indexes. Lives in URLs, attestation rows, cached
client state, and federated cross-AppView references. Two
implementations indexing the same firehose **must produce the same
`subject_id`** for the same `SubjectRef` or federation breaks.

## Wire format

```
sub_<32 hex chars>     // total length 36, lowercase hex
```

Computed as:

```
subject_id = "sub_" + lowercase_hex(SHA-256(canonical_input)).slice(0, 32)
```

where `canonical_input` is one of (highest priority first):

| Tier | Input ref carries | `canonical_input` |
|---|---|---|
| 1a | `did`        | `"v3:did:" + did` |
| 1b | `uri`        | `"v3:uri:" + canonicalize_uri(uri)` |
| 1c | `identifier` | `"v3:id:" + canonicalize_identifier(identifier)` |
| 2  | `name` only  | `"v3:name:" + lowercase(type) + ":" + normalize_name(name)` |

**Tier-1 precedence is TYPE-SPECIFIC (v3).** `did` always wins. After
that the order depends on `ref.type`:

- **`product` / `dataset`** (physical goods): `identifier` (barcode /
  ASIN / MPN — the precise SKU) **beats** `uri`. The barcode is the
  correct variant-level key; a store page URL is weaker + fragmenting.
- **`content` / `place` / `organization` / `claim` / `did`**: `uri`
  (the canonical content URL/ID) **beats** `identifier`. The URL *is*
  the content's identity.
- `name` (Tier 2) is always the last resort.

A `SubjectRef` with none of `did` / `uri` / `identifier` / non-empty
`name` is **invalid** and the resolver throws.

## The `v3:` version prefix

Every hash input is prefixed with the literal string `v3:`. This is
the current resolver formula version. If the formula ever evolves
(new normalization rules, additional inputs), a `v4:` prefix on
new inputs produces a disjoint id space; old subjects retain
their ids until explicitly migrated.

Federated implementations MUST emit `v3:` as the prefix.

**v2 → v3 change (launch):** v3 adds (a) the type-specific Tier-1
precedence above, and (b) the per-type identifier canonicalizer below
(YouTube URL → `youtube:<id>`, tracking-param strip, GTIN/ASIN
format-normalize). Both change the hash inputs, so the prefix moved
`v2:`→`v3:`. At launch this was a **greenfield** bump — no public v2
subjects existed to migrate.

## Tier 1 normalization

### `did:` — verbatim

The DID string is hashed **verbatim**. No lowercasing, no trimming, no
Unicode normalization. Callers own the canonical form (DIDs are
lowercase by `did:plc` method spec).

**Presence + tier selection.** A Tier 1 field is *present* iff it is
a non-empty string (length > 0). Tier selection is `did` first, then
the **type-specific** order above (`identifier`/`uri` swap by type),
then name; the first present field wins. Because `did` hashing is
verbatim, surrounding whitespace is identity-significant
(`"did:plc:x "` ≠ `"did:plc:x"`). Implementations **SHOULD** reject
whitespace-padded or whitespace-only Tier 1 values at the
record-validation boundary so the verbatim hash only ever sees
canonical input — a non-empty-but-blank value is a caller bug, not a
distinct subject. The hash function itself does NOT trim (a verbatim
contract can't depend on a normalization step some ports skip).

### `id:` — per-type identifier canonicalizer (v3)

`canonicalize_identifier(identifier)` format-normalizes a namespaced
`<scheme>:<value>` identifier (mostly passthrough):

- scheme **lowercased** (`ASIN:` == `asin:`);
- `asin` value **uppercased** (ASINs are case-insensitive alphanumerics);
- `gtin` / `ean` / `upc` numeric value → **unified to `gtin:<value
  left-zero-padded to 14 digits>`** (GS1 GTIN-14 canonical form). A UPC-A
  (12), the EAN-13, and the GTIN-14 of the same product are the SAME GS1
  code at different lengths, so the scheme collapses to `gtin` and all
  three converge to one subject id;
- any other scheme — or an identifier with no `:`, or a non-numeric GTIN
  value — passes through **verbatim** (we don't guess at formats we don't
  recognise).

Namespaced examples: `asin:B01234ABCD`, `gtin:00036000291452`,
`wikidata:Q28865`.

### `uri:` — platform-ID extraction + conservative RFC 3986 normalization (v3)

`canonicalize_uri(uri)` first tries to extract a **platform content
ID**, then falls back to conservative RFC 3986 normalization:

- **YouTube** links (`youtube.com/watch?v=`, `youtu.be/`,
  `/embed/`, `/shorts/`, `/live/`, `m.`/`www.`/`music.` hosts) →
  `youtube:<videoId>`. All spellings of one video converge; timestamp
  (`t=`), playlist (`list=`/`index=`), and tracking params are
  irrelevant (only the 11-char id is read).
- **Generic URLs** → RFC 3986 foldings (below) PLUS **tracking-param
  stripping** (`utm_*`, `fbclid`, `gclid`, `ref`, etc.). Surviving
  query params are PRESERVED verbatim, in original order (the query is
  often the routing key, and order MAY be semantic — reordering would
  risk conflating distinct resources).

The RFC 3986 foldings (generic path) apply only equivalences RFC 3986
considers safe:

1. **Lowercase scheme.** `HTTPS://x.test` → `https://x.test` (RFC
   3986 §3.1, scheme is case-insensitive).
2. **Lowercase host.** `https://Example.COM` → `https://example.com`
   (RFC 3986 §3.2.2, host is case-insensitive). IPv6 literals keep
   their `[...]` brackets; hex digits inside lowercase.
3. **Strip default ports.** Remove `:80` on `http:`, `:443` on
   `https:`, `:21` on `ftp:`, `:22` on `ssh:`, `:23` on `telnet:`,
   `:25` on `smtp:`.
4. **Strip a single trailing slash on the empty path.**
   `https://x.test/` → `https://x.test`. Trailing slashes on
   non-root paths are PRESERVED (`/page` ≠ `/page/`).
5. **Strip the fragment.** `https://wiki.test/Python#History` →
   `https://wiki.test/Python`. RFC 3986 fragments are client-side
   anchors and don't affect the resource the server returns — two
   reviewers pointing at different sections of the same article are
   reviewing the same article. Publishers that want per-fragment
   identity (e.g. SPA routes) should use the `identifier` field
   instead.

Things that are **NOT** normalized (semantic, preserve verbatim):

- Path case (servers may be case-sensitive).
- Query string order, case, percent-encoding.
- Percent-encoded characters (`%2F` is not decoded to `/`).
- Userinfo (`user:pass@`).

If `new URL(raw)` throws (malformed URI), implementations MUST fall
back to hashing the raw string verbatim. The resolver does not
crash on invalid input.

## Tier 2 normalization (name-only)

`normalize_name(name)` and `lowercase(type)`:

1. **NFC composition.** `"café"` decomposed (`e + U+0301`) folds to
   `"café"` composed (`U+00E9`).
2. **Lowercase.** Locale-independent (use the no-argument JS
   `String.prototype.toLowerCase()` semantics, or equivalent
   Unicode case-folding without a locale tailoring — Turkish `İ`
   must NOT alter `i`).
3. **Collapse whitespace runs.** All Unicode whitespace runs
   (space, tab, newline, NBSP, etc.) collapse to a single ASCII
   space; leading + trailing whitespace stripped.
4. **Reject empty.** If the result is the empty string, the
   `SubjectRef` is invalid.
5. **Reject overlong.** If the result exceeds 200 code points, the
   `SubjectRef` is invalid. This matches the lexicon validator's
   `name.max(200)` bound — resolver and wire-format gate share the
   same limit so federated implementations behave identically.

Equivalent rules apply to the type:

- Lowercase + trim. `"Product "` and `"product"` produce the same
  hash.

The `type` enum is the closed set
`{did, content, product, dataset, organization, claim, place}`.
Unknown types may exist in older records — the resolver still
hashes them, but new producers should stay within the closed set.

## Examples

| `SubjectRef`                                                      | `subject_id` derivation                              |
|--------------------------------------------------------------------|-------------------------------------------------------|
| `{type:"did", did:"did:plc:abc"}`                                  | `SHA256("v3:did:did:plc:abc")[:32]`                  |
| `{type:"content", uri:"HTTPS://Example.COM/"}`                     | `SHA256("v3:uri:https://example.com")[:32]`          |
| `{type:"content", uri:"https://youtu.be/dQw4w9WgXcQ?t=42"}`        | `SHA256("v3:uri:youtube:dQw4w9WgXcQ")[:32]`          |
| `{type:"product", identifier:"ASIN:b01234abcd"}`                   | `SHA256("v3:id:asin:B01234ABCD")[:32]`               |
| `{type:"product", uri:"…/dp/X", identifier:"asin:X"}` (both)       | resolves by **identifier** (product: id beats uri)    |
| `{type:"content", uri:"…", identifier:"…"}` (both)                 | resolves by **uri** (content: uri beats id)           |
| `{type:"product", name:"  Aeron  Chair  "}`                        | `SHA256("v3:name:product:aeron chair")[:32]`         |
| `{type:"place", name:"café"}` (decomposed `é`)                     | `SHA256("v3:name:place:café")[:32]` (composed `é`)    |

## Disambiguation policy

When the same human concept might collide on a name (e.g. "Python"
the language vs the snake), callers SHOULD supply a Tier 1
disambiguator:

- DIDs for personas, organizations.
- URIs for content (articles, videos, pages).
- Namespaced identifiers for products (`asin:B01234`, `ean:...`,
  `wikidata:Q28865`).

Implementations MUST NOT silently fork name-collided subjects;
disambiguation is a publisher responsibility.

## Canonical chain resolution

After computing `subject_id`, implementations resolve through the
`canonical_subject_id` column if set. `canonical_subject_id`
points to a merge target; resolvers walk the chain (with cycle
detection + max-depth bound) and return the canonical row's id.

The cycle-safe walk is independently testable from the hash
formula; see `appview/src/db/queries/subjects.ts:resolveCanonicalChain`.

## Source of truth

- Code: [`appview/src/db/queries/subjects.ts`](../../../../appview/src/db/queries/subjects.ts) —
  `generateDeterministicId`, `normalizeNameForHash`,
  `normalizeTypeForHash`; and
  [`appview/src/db/queries/subject_identifier.ts`](../../../../appview/src/db/queries/subject_identifier.ts) —
  `tier1Precedence`, `canonicalizeUri`, `canonicalizeIdentifier`,
  `resolveTier1Key` (the v3 type-precedence + canonicalizer).
- Constants: `RESOLVER_VERSION = 'v3'`,
  `CONSTANTS.SUBJECT_REF_MAX_NAME_LEN = 200`,
  `CONSTANTS.SUBJECT_REF_MAX_IDENTIFIER_LEN = 500`,
  `CONSTANTS.SUBJECT_REF_MAX_URI_LEN = 2048`,
  `CONSTANTS.SUBJECT_REF_MAX_DID_LEN = 2048`.
- Tests: `appview/tests/unit/03-shared-utilities.test.ts` (UT-DI-001
  through UT-DI-034) lock the formula + every normalization rule;
  `appview/tests/unit/subject_identifier.test.ts` locks the v3
  type-precedence + YouTube/identifier canonicalization.

## Vectors

The TS resolver's unit tests
(`appview/tests/unit/03-shared-utilities.test.ts`, cases UT-DI-001
through UT-DI-034) serve as the reference vectors. A future
`conformance/vectors/subject_id.json` will lift the same cases into
the cross-language conformance harness; until that lands, target
the TS test inputs/outputs directly.
