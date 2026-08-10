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

import { detectPII } from '../pii/patterns';

/**
 * The closed public vocabulary (§12.1 rule 1).
 *
 * THIS LIST IS THE `CatalogItem` WIRE TYPE, and it has to be, which is a
 * lesson that cost a real defect. It was first written from §12.1's prose as a
 * hand-picked set — `category`, `regions`, `list_price`, `pack_size` — while
 * `@dina/commerce-protocol` defines the published item as `category_ids`,
 * `fulfilment_regions`, `indicative_price`, `pack`. The two vocabularies never
 * met, so **this gate refused every item shape AppView's ingest requires**: a
 * supplier publishing a real `CatalogItem` could not get past their own node's
 * publication gate.
 *
 * NOTHING ON EITHER SIDE COULD SEE IT. Core's publisher tests used a flat
 * `{sku, name}` CSV shape, and AppView's ingest tests hand-built `CatalogItem`s
 * and never called Core's publisher. It took a fixture that carries one side's
 * BYTES to the other — `catalog_interop_fixture.test.ts` — and it failed on its
 * first run.
 *
 * So the list now covers the wire type's field names AND the flat CSV column
 * names an import produces before normalization, and
 * `catalog_leakage_vocabulary.test.ts` asserts that every field a valid
 * `CatalogItem` can carry is in here. That test is the actual fix; this list is
 * data it checks.
 *
 * Still deliberately SMALL beyond that. Every addition that is not required by
 * the wire type is a decision to publish a new kind of fact about a supplier's
 * business for ever, and the right default for a field nobody has argued for is
 * "not in the catalog".
 */
export const PUBLIC_CATALOG_FIELDS: ReadonlySet<string> = new Set([
  // --- §9.3 identity: what the product IS -----------------------------------
  'product',
  'scheme',
  'value',
  // Part of a §9.3 ProductRef, not an extra. A `manufacturer_sku` or `custom`
  // reference is ambiguous WITHOUT its issuer — two suppliers may both call
  // something CHAIR-1 — so the issuing DID travels with the identity and is
  // public by construction.
  'issuer_did',
  'variant_digest',
  // §9.4 relationship claims. `family_ref` and `formulation_ref` are
  // ProductRefs; `relationship_claim_refs` are AT-URIs of signed assertions.
  'family_ref',
  'formulation_ref',
  'relationship_claim_refs',
  'variant_of',
  'variant_axes',
  // --- who published it, and which catalog it belongs to --------------------
  // Public by construction: the record is signed by this DID and indexed under
  // this catalog. Refusing them meant refusing every real `CatalogItem`.
  'supplier_did',
  'catalog_id',
  'item_revision',
  // --- supplier-side identifiers -------------------------------------------
  // Printed on the packaging, so their publicness is not a judgement call.
  // `identifiers` is the wire type's array of secondary ProductRefs; `sku` and
  // `mpn` are the flat CSV columns an import produces before normalization.
  'identifiers',
  'sku',
  'mpn',
  // --- presentation ---------------------------------------------------------
  'name',
  'description',
  // BOTH LANES. `category_ids` is the wire type's array; `category` is the
  // flat CSV column an import produces before normalization. Reconciling this
  // list to the wire type dropped the flat one and broke every spreadsheet
  // import — caught by an existing test, which is why the pair is now named
  // together with the reason.
  'category_ids',
  'category',
  'brand',
  'image_url',
  // --- commercial surface a buyer needs to decide whether to ask for a quote -
  'pack',
  'sell_unit',
  'units_per_pack',
  'unit_code',
  'pack_size',
  'minimum_order',
  'min_order_quantity',
  'lead_time_days',
  'fulfilment_regions',
  'regions',
  'availability',
  'freshness',
  'generated_at',
  'valid_until',
  // An indicative price is PUBLIC by the supplier's own choice; a real price
  // still comes from a signed quote (§9.8), so this is advertising and not a
  // term (§10.4).
  'indicative_price',
  'list_price',
  'currency',
  'minor_units',
  // §9.5 bounded attribute map. The KEY `attributes` is public; the keys
  // INSIDE it are supplier-chosen and handled separately — see the walk.
  'attributes',
]);

export type LeakageRefusal =
  /** A field outside the closed public vocabulary. */
  | 'unknown_public_field'
  /** A value that looks like a credential. */
  | 'secret_shaped_value'
  /**
   * §12.1 step 10 — a value carrying a structured personal identifier: a
   * phone, an email, an account or an ID number. Distinct from
   * `secret_shaped_value`, because the two send an operator to different
   * places: one means "rotate that credential", the other means "a person's
   * details are in your catalog export".
   */
  | 'personal_identifier_value'
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

/**
 * §12.1 step 10 — the structured-identifier PII half of the value scan.
 *
 * THE SPEC NAMES THIS EXPLICITLY and it was missing: "validation runs
 * value-level scanning with the existing structured-identifier PII patterns
 * (phone, email, account and ID number shapes) PLUS a secret-shaped-token
 * detector". Only the second half was built. The first half is not new work —
 * `detectPII` is the scrubber Core already runs on the egress path — so the
 * gap was wiring, not capability, which is why nothing looked missing.
 *
 * WHAT IS AND IS NOT CLAIMED. §12.1 is unusually careful here and this follows
 * it: identifier and credential SHAPES, and no promise of person-name
 * detection. The closed vocabulary above is what keeps prose out of public
 * fields; this is the residual case where a legal field carries a value that
 * belongs to a person. `IP` and `ADDRESS` are in `detectPII` and are NOT used
 * here — §12.1 names neither, an address is a legitimate thing for a supplier
 * to describe, and a gate that refuses "ships from 12 Mill Road" would be
 * disabled within a week.
 */
const PERSONAL_IDENTIFIER_TYPES: ReadonlySet<string> = new Set([
  'EMAIL',
  'PHONE',
  'SSN',
  'AADHAAR',
  'PAN',
  'IFSC',
  'UPI',
  'BANK_ACCT',
  'CREDIT_CARD',
]);

/**
 * Fields whose declared meaning is a PRODUCT number, and every class that
 * collides with one there.
 *
 * ONE LIST, IN ONE PLACE. This block and the function below used to disagree
 * about how long the list was — one said "two collisions", the other said
 * "three" — which in a file whose comments ARE the decision record is how the
 * next error gets made.
 *
 * THIS RULE HAS BEEN WRONG THREE TIMES and every error was the same mistake:
 * reasoning about a class instead of measuring it.
 *
 *  1. It excluded `BANK_ACCT` and `CREDIT_CARD` on a general principle about
 *     alphanumeric runs, and a valid card number in a `sku` column published
 *     clean.
 *  2. It admitted both back because "`CREDIT_CARD` is Luhn-validated" — which
 *     settles `BANK_ACCT` and not `CREDIT_CARD`, whose pattern takes 13 to 19
 *     digits while a GTIN-13 is thirteen. Measured: `5901234123457` and
 *     `4901234567894` are real GTIN-13s that pass Luhn.
 *  3. It left `AADHAAR` scanning, which is twelve digits, as is UPC-A.
 *     Measured: `712345678904` is a valid UPC-A read as an Aadhaar number.
 *
 * FIVE EXCLUSIONS, and they split into two kinds. The first three have a
 * MEASURED boundary, because what they compete with is a GTIN — a closed set
 * of lengths with a check digit, so the line can be derived:
 *
 * - `PHONE` — always. The US pattern is not anchored at its start, so it finds
 *   a ten-digit window inside ANY longer digit run.
 * - `CREDIT_CARD` — below fifteen digits, where a GTIN can reach (8, 12, 13,
 *   14). Fifteen and up cannot be one.
 * - `AADHAAR` — only when the match carries no separator. Twelve bare digits
 *   cannot be told from a UPC-A; a real Aadhaar written `2345 6789 0123` keeps
 *   its spacing and stays refused, so the separator is the only signal there
 *   is and it is the one used. `PHONE` does not cover this case: inside a
 *   twelve-digit run the phone rule matches a ten-digit window,
 *   `resolveOverlaps` drops the shorter match, and the AADHAAR span survives.
 *
 * The last two are a CHOICE and not a measurement, and saying so is the point:
 *
 * - `PAN` (`[A-Z]{5}\d{4}[A-Z]`) and `IFSC` (`[A-Z]{4}0[A-Z0-9]{6}`) compete
 *   with `sku`, `mpn` and `custom` values — supplier-chosen strings with no
 *   length bound, no vocabulary and no check digit. There is no boundary to
 *   derive, so no amount of measuring settles it. Measured only that the
 *   collision is real and ordinary: `CHAIR2024B` is refused as a tax ID and
 *   `ACME012345X` as a bank branch code.
 *
 *   Excluded, on the asymmetry. A supplier cannot renumber their catalog, so a
 *   false positive makes an honest SKU scheme permanently unpublishable; while
 *   a genuine PAN or IFSC in a `sku` column is a deliberate act rather than the
 *   ERP-export accident this scan exists for. §12.1 is explicit that this layer
 *   is defence in depth and that the CLOSED VOCABULARY is the primary control.
 *   Free-text fields still scan both at full strength, which is where a leaked
 *   contact block actually arrives.
 *
 * Everything else scans normally in these fields, including `BANK_ACCT`:
 * sixteen bare digits, and no product-code standard is sixteen (SSCC is
 * eighteen, ITF-14 is fourteen).
 *
 * WHAT THE CARD BOUNDARY KNOWINGLY GIVES UP: a Diners Club number is fourteen
 * digits, so a 13- or 14-digit card pasted into a product-number field is not
 * scanned. That is the accepted side of the trade — the alternative refuses
 * about a tenth of honest GTIN-13/14 catalogs.
 *
 * Free-text fields keep the FULL scan. A description reading "Model
 * 9506000134352" will be refused, and that is the accepted cost: moving the
 * code into `sku` takes seconds, a published customer phone number is public
 * for ever.
 */
const PRODUCT_NUMBER_FIELDS: ReadonlySet<string> = new Set(['value', 'sku', 'mpn']);
/** Longest GTIN. A numeric match above this cannot be a product number. */
const MAX_GTIN_DIGITS = 14;

/** Does this match collide with an honest product number? See above. */
function collidesWithProductNumber(type: string, value: string): boolean {
  if (type === 'PHONE' || type === 'PAN' || type === 'IFSC') return true;
  if (type === 'CREDIT_CARD') return value.replace(/\D/g, '').length <= MAX_GTIN_DIGITS;
  if (type === 'AADHAAR') return !/[\s-]/.test(value);
  return false;
}

function scanForPersonalIdentifiers(value: string, path: string, out: LeakageFinding[]): void {
  const leaf = path.slice(path.lastIndexOf('.') + 1);
  const productNumber = PRODUCT_NUMBER_FIELDS.has(leaf);
  const reported = new Set<string>();
  for (const match of detectPII(value)) {
    if (!PERSONAL_IDENTIFIER_TYPES.has(match.type)) continue;
    if (productNumber && collidesWithProductNumber(match.type, match.value)) continue;
    // ONE finding per type per field. Ten emails in a description is one
    // problem to fix, and listing it ten times pushes other findings past the
    // reporting cap.
    if (reported.has(match.type)) continue;
    reported.add(match.type);
    // The TYPE, never the value — the same rule as the secret scan. A finding
    // that quoted the phone number would copy it into the log.
    out.push({
      refusal: 'personal_identifier_value',
      path,
      detail: `value contains something shaped like a ${match.type.toLowerCase()} (§12.1)`,
    });
  }
}

/** Depth a catalog item may nest. Beyond this, a "product" is a document. */
const MAX_ITEM_DEPTH = 4;

/** The one field whose child keys are the supplier's own words (§9.5). */
const ATTRIBUTES_FIELD = 'attributes';

/**
 * Scan an `attributes` map's VALUES without treating its keys as vocabulary.
 *
 * Flat by construction: §9.5 bounds attribute values to string, number or
 * boolean, so there is no subtree here and nothing to recurse into. A nested
 * object under `attributes` is malformed rather than deep, and
 * `validateCatalogItem` refuses it before publication — so this reports it as
 * a structural fault instead of silently walking something the wire type does
 * not permit.
 */
function walkAttributeValues(value: unknown, path: string, out: LeakageFinding[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push({
      refusal: 'malformed_item',
      path,
      detail: 'attributes must be a flat object (§9.5)',
    });
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (typeof child === 'string') {
      walk(child, childPath, 0, out);
      continue;
    }
    if (typeof child === 'number' || typeof child === 'boolean') continue;
    out.push({
      refusal: 'malformed_item',
      path: childPath,
      detail: 'an attribute value must be a string, number or boolean (§9.5)',
    });
  }
}

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
    scanForPersonalIdentifiers(value, path, out);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`, depth + 1, out));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === ATTRIBUTES_FIELD) {
      // §9.5 — a BOUNDED free-form map, so its keys are supplier-chosen and
      // cannot be vocabulary; refusing them refused every item that used the
      // feature the wire type provides. The VALUES are still supplier text
      // reaching a public record, which is precisely where the value scan
      // belongs, so the subtree is walked with the vocabulary check skipped
      // one level rather than skipped entirely.
      walkAttributeValues(child, `${path}.${key}`, out);
      continue;
    }
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
