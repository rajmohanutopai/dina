/**
 * Turn a URL query string into the object an xRPC route's schema validates.
 *
 * WHY THIS IS NOT `Object.fromEntries(searchParams.entries())`, which is what
 * it replaces. `entries()` yields one pair per VALUE, so a repeated parameter
 * collapses to whichever copy came last — and `fromEntries` keeps the last of
 * those. A schema field declared as an array can then never be satisfied: the
 * caller sends `?category=a&category=b`, the route sees the string `'b'`, and
 * zod answers `Expected array, received string`. The endpoint returns 400 for
 * every well-formed request that uses the field.
 *
 * That is not hypothetical. `com.dinakernel.commerce.searchCatalog` declares
 * `identifier` and `category` as arrays — the two strongest discovery signals,
 * an exact product identifier and a category — and neither could be supplied
 * over HTTP at all. Free text and region worked, so the endpoint looked alive.
 *
 * A REPEATED KEY BECOMES AN ARRAY, a single key stays a scalar. Both shapes
 * reach the schema, which is where the decision about arity belongs: a route
 * whose field is a scalar still gets a string, and a route whose field is a
 * list accepts one value or many (see `queryList`).
 *
 * NO COMMA SPLITTING. `?category=a,b` stays one value. A comma is a legal
 * character inside a category id, a product identifier and a supplier DID, so
 * splitting on it would silently turn one caller's value into two — the same
 * class of mistake as joining keys with a separator that can appear inside a
 * field.
 */
export function queryToRecord(searchParams: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key)
    // `getAll` never returns empty for a key that `keys()` yielded, so the
    // index is safe; the fallback keeps the types honest rather than guarding
    // a case the API cannot produce.
    out[key] = values.length > 1 ? values : (values[0] ?? '')
  }
  return out
}
