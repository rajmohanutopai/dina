/**
 * Publication leakage gate (§12.1, §23) — the last thing between a supplier's
 * private data and a permanent public record.
 *
 * WHY THIS IS DIFFERENT FROM EVERY OTHER VALIDATOR HERE. A rejected order can
 * be resubmitted; a bad quote expires. A catalog snapshot is published to a
 * PDS, indexed by an AppView, and content-addressed — it does not un-publish.
 * A credential that reaches one is disclosed, permanently, to everyone. So
 * this gate is the one place in the commerce pack where the cost of a false
 * NEGATIVE is unbounded and the cost of a false positive is an annoyed
 * supplier who renames a column.
 *
 * That asymmetry decides every judgement call below. Where a rule could go
 * either way, it goes the refusing way, and the refusal names the field so the
 * supplier can act on it without being told what the offending value was —
 * echoing a secret into an error message is how a leak becomes two leaks.
 *
 * TWO INDEPENDENT RULES, both required (§12.1):
 *
 *   1. A CLOSED public-field vocabulary. Only fields a catalog is supposed to
 *      carry may appear at all. This is the load-bearing half: it stops
 *      `internal_cost`, `supplier_notes` and `api_key` by not knowing what
 *      they are, rather than by recognising them.
 *   2. A secret-SHAPED-token detector over the values that survive rule 1.
 *      Field names are chosen by the supplier, so a closed vocabulary alone
 *      cannot stop a token pasted into `description`.
 *
 * Rule 1 without rule 2 publishes a key in a legal field. Rule 2 without rule
 * 1 publishes a cost column that looks like nothing in particular. Neither
 * subsumes the other, which is why both are here and why removing either is a
 * change to what this node discloses rather than a refactor.
 */

/**
 * Fields a public catalog item may carry (§12.1).
 *
 * Deliberately SMALL. Every addition is a decision to publish a new kind of
 * fact about a supplier's business for ever, and the right default for a
 * field nobody has argued for is "not in the catalog".
 */
export const PUBLIC_CATALOG_FIELDS: ReadonlySet<string> = new Set([
  // Identity — what the product IS (§9.3, §9.4).
  'product',
  'scheme',
  'value',
  // Part of a §9.3 ProductRef, not an extra. A `manufacturer_sku` or `custom`
  // reference is ambiguous WITHOUT its issuer — two suppliers may both call
  // something CHAIR-1 — so the issuing DID travels with the identity and is
  // public by construction. Omitting it from this list meant no scoped product
  // reference could be published at all, which the importer found by
  // producing one.
  'issuer_did',
  'variant_digest',
  'variant_of',
  'variant_axes',
  // Supplier-side identifiers. These are printed on the packaging, so their
  // publicness is not a judgement call. They are a second way to say what
  // `product: {scheme, value}` says canonically, which is a real tension —
  // recorded rather than resolved, because refusing a `sku` column would make
  // the gate fail every honest CSV import for a reason that has nothing to do
  // with leakage.
  'sku',
  'mpn',
  // Presentation.
  'name',
  'description',
  'category',
  'brand',
  'image_url',
  // Commercial surface a buyer needs to decide whether to ask for a quote.
  'unit_code',
  'pack_size',
  'min_order_quantity',
  'lead_time_days',
  'regions',
  'availability',
  // List price is PUBLIC by the supplier's own choice; a real price still
  // comes from a signed quote (§9.8), so this is advertising, not a term.
  'list_price',
  'currency',
  'minor_units',
]);

export type LeakageRefusal =
  /** A field outside the closed public vocabulary. */
  | 'unknown_public_field'
  /** A value that looks like a credential. */
  | 'secret_shaped_value'
  /** Structure a catalog item may not have (nesting depth, non-object item). */
  | 'malformed_item';

export interface LeakageFinding {
  refusal: LeakageRefusal;
  /** Dotted path to the offending field. NEVER carries the value itself. */
  path: string;
  detail: string;
}

/**
 * Value shapes that read as credentials.
 *
 * Every pattern here is anchored on structure a human would not type into a
 * product description by accident. The list is knowingly incomplete — that is
 * what rule 1 is for — and its job is the residual case where a legal field
 * carries an illegal value.
 */
const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  // Vendor-prefixed API keys: `sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`.
  { name: 'vendor api key', re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { name: 'slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'aws access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // A JWT is three base64url segments separated by dots.
  { name: 'json web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  // PEM blocks — the whole point of the armour is that it is recognisable.
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // A URL carrying credentials in its authority.
  { name: 'credentials in url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  // `password=…`, `api_key: …`, `secret = …` — the label plus a value.
  {
    name: 'labelled secret',
    re: /\b(?:password|passwd|api[_-]?key|secret|token|credential)\b\s*[:=]\s*\S{6,}/i,
  },
];

/** Depth a catalog item may nest. Beyond this, a "product" is a document. */
const MAX_ITEM_DEPTH = 4;

/**
 * Check ONE catalog item, returning every finding rather than the first.
 *
 * All of them, because a supplier fixing a spreadsheet wants the whole list —
 * a gate that reports one problem per attempt turns a five-minute fix into
 * five publication attempts, and each attempt is a chance to give up and
 * disable the gate.
 */
export function findCatalogLeakage(item: unknown, itemPath = 'item'): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  walk(item, itemPath, 0, findings);
  return findings;
}

function walk(value: unknown, path: string, depth: number, out: LeakageFinding[]): void {
  if (depth > MAX_ITEM_DEPTH) {
    out.push({
      refusal: 'malformed_item',
      path,
      detail: `nested deeper than ${String(MAX_ITEM_DEPTH)} levels`,
    });
    return;
  }
  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(value)) {
        // The finding names the FIELD and the pattern, never the value. An
        // error message is written to a log, and a log is another place a
        // secret can come to rest.
        out.push({
          refusal: 'secret_shaped_value',
          path,
          detail: `value looks like a ${pattern.name}`,
        });
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`, depth + 1, out));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!PUBLIC_CATALOG_FIELDS.has(key)) {
      // Named, not valued. The field name is the supplier's own word and is
      // safe to echo; whatever is inside it is exactly what must not be.
      out.push({
        refusal: 'unknown_public_field',
        path: `${path}.${key}`,
        detail: 'not in the public catalog vocabulary (§12.1)',
      });
      // Do NOT descend. The subtree is already refused, and walking it would
      // report the same problem once per leaf.
      continue;
    }
    walk(child, `${path}.${key}`, depth + 1, out);
  }
}

/**
 * Gate a whole item list before publication.
 *
 * Returns findings across every item, capped so a pathological catalog cannot
 * turn one refusal into a megabyte of error text. The cap is REPORTED rather
 * than silent — an operator who fixes twenty findings and republishes needs to
 * know whether twenty was all of them.
 */
export interface LeakageVerdict {
  clean: boolean;
  findings: LeakageFinding[];
  /** Findings beyond the reporting cap. Zero when the list is complete. */
  truncated: number;
}

const MAX_REPORTED_FINDINGS = 100;

export function gateCatalogForPublication(items: readonly unknown[]): LeakageVerdict {
  const findings: LeakageFinding[] = [];
  let total = 0;
  items.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      total += 1;
      if (findings.length < MAX_REPORTED_FINDINGS) {
        findings.push({
          refusal: 'malformed_item',
          path: `items[${String(index)}]`,
          detail: 'catalog items must be objects',
        });
      }
      return;
    }
    for (const finding of findCatalogLeakage(item, `items[${String(index)}]`)) {
      total += 1;
      if (findings.length < MAX_REPORTED_FINDINGS) findings.push(finding);
    }
  });
  return {
    clean: total === 0,
    findings,
    truncated: Math.max(0, total - findings.length),
  };
}
