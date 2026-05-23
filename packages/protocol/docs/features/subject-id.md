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
| 1a | `did`        | `"v2:did:" + did` |
| 1b | `uri`        | `"v2:uri:" + normalize_uri(uri)` |
| 1c | `identifier` | `"v2:id:" + identifier` |
| 2  | `name` only  | `"v2:name:" + lowercase(type) + ":" + normalize_name(name)` |

If multiple fields are present, Tier 1a > 1b > 1c > 2 (first match wins).

A `SubjectRef` with none of `did` / `uri` / `identifier` / non-empty
`name` is **invalid** and the resolver throws.

## The `v2:` version prefix

Every hash input is prefixed with the literal string `v2:`. This is
the current resolver formula version. If the formula ever evolves
(new normalization rules, additional inputs), a `v3:` prefix on
new inputs produces a disjoint id space; old `v2:` subjects retain
their ids until explicitly migrated.

Federated implementations MUST emit `v2:` as the prefix for now.
A future spec update will publish `v3:` rules + a migration path.

## Tier 1 normalization

### `did:` and `id:` — verbatim

The DID and identifier strings are hashed **verbatim**. No
lowercasing, no trimming, no Unicode normalization. Callers are
responsible for the canonical form of these strings (DIDs are
lowercase by `did:plc` method spec; identifiers should be namespaced
e.g. `asin:B01234`, `ean:0123456789012`, `wikidata:Q28865`).

**Presence + tier selection.** A Tier 1 field is *present* iff it is
a non-empty string (length > 0). Tier selection is `did` → `uri` →
`identifier` → name; the first present field wins. Because hashing is
verbatim, surrounding whitespace is identity-significant
(`"did:plc:x "` ≠ `"did:plc:x"`). Implementations **SHOULD** reject
whitespace-padded or whitespace-only Tier 1 values at the
record-validation boundary so the verbatim hash only ever sees
canonical input — a non-empty-but-blank value is a caller bug, not a
distinct subject. The hash function itself does NOT trim (a verbatim
contract can't depend on a normalization step some ports skip).

### `uri:` — conservative RFC 3986 normalization

`normalize_uri(uri)` applies only foldings that RFC 3986 considers
equivalent:

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
| `{type:"did", did:"did:plc:abc"}`                                  | `SHA256("v2:did:did:plc:abc")[:32]`                  |
| `{type:"content", uri:"HTTPS://Example.COM/"}`                     | `SHA256("v2:uri:https://example.com")[:32]`          |
| `{type:"product", identifier:"asin:B01234"}`                       | `SHA256("v2:id:asin:B01234")[:32]`                   |
| `{type:"product", name:"  Aeron  Chair  "}`                        | `SHA256("v2:name:product:aeron chair")[:32]`         |
| `{type:"place", name:"café"}` (decomposed `é`)                     | `SHA256("v2:name:place:café")[:32]` (composed `é`)    |

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
  `normalizeUriForHash`, `normalizeTypeForHash`.
- Constants: `RESOLVER_VERSION = 'v2'`,
  `CONSTANTS.SUBJECT_REF_MAX_NAME_LEN = 200`,
  `CONSTANTS.SUBJECT_REF_MAX_IDENTIFIER_LEN = 500`,
  `CONSTANTS.SUBJECT_REF_MAX_URI_LEN = 2048`,
  `CONSTANTS.SUBJECT_REF_MAX_DID_LEN = 2048`.
- Tests: `appview/tests/unit/03-shared-utilities.test.ts` (UT-DI-001
  through UT-DI-034) lock the formula + every normalization rule.

## Vectors

The TS resolver's unit tests
(`appview/tests/unit/03-shared-utilities.test.ts`, cases UT-DI-001
through UT-DI-034) serve as the reference vectors. A future
`conformance/vectors/subject_id.json` will lift the same cases into
the cross-language conformance harness; until that lands, target
the TS test inputs/outputs directly.
