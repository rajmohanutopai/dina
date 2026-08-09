/**
 * Supplier catalog import (§12.1, FR-S2, FR-S3) — a spreadsheet becomes
 * publishable catalog items, or it does not.
 *
 * WHY CSV FIRST. A supplier's catalog already exists, in a spreadsheet. Any
 * design that begins by asking them to re-enter it in a form is a design that
 * gets a ten-row catalog for the demo and nothing afterwards. So the import
 * takes the file they have and tells them precisely what is wrong with it.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: A BAD ROW IS NEVER DROPPED.
 *
 * The tempting behaviour — import what parses, skip the rest, report a count —
 * is wrong in a way that is hard to see and expensive to discover. A catalog
 * snapshot is FULL STATE (§10.2): publishing it says "this is everything I
 * offer". A supplier whose 40-row file imported 37 rows has published a
 * catalog that silently omits three products, and nothing in the record says
 * so. Buyers do not see an error; they see a supplier who does not stock the
 * thing. So an import either yields every row or it yields none, and the
 * findings say which rows and why.
 *
 * WHAT THIS DOES NOT DO. It does not publish, and it does not check for
 * leakage — `buildCatalogSnapshot` owns that gate (§12.1) and owns it alone,
 * so there is exactly one place a leak can be stopped and no second copy to
 * drift from it. This module's job ends at "these rows are structurally a
 * catalog".
 */

import { unitDef, validateProductRef, type ProductRef } from '@dina/commerce-protocol';

/** Columns the importer understands. Everything else is a finding. */
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([
  'sku',
  'mpn',
  'scheme',
  'identifier',
  'name',
  'description',
  'category',
  'brand',
  'unit_code',
  'pack_size',
  'min_order_quantity',
  'lead_time_days',
  'variant_of',
  'list_price_minor_units',
  'currency',
]);

/**
 * Product identifier schemes a CSV may name, and what each becomes (§9.3).
 *
 * The CSV vocabulary and the PROTOCOL vocabulary are not the same, and the
 * first version of this file pretended they were: it built
 * `{scheme: 'sku', value}` and cast it to `ProductRef`. `sku` is not a
 * protocol scheme (the four are `gtin | manufacturer_sku | dina_subject |
 * custom`), and `manufacturer_sku` additionally REQUIRES an `issuer_did`
 * without which the reference is ambiguous across suppliers. The cast hid
 * both, so every imported catalog carried product references that
 * `validateProductRef` rejects — found while writing an unrelated module,
 * which is the usual way a cast is found.
 *
 * `mpn` is deliberately NOT an importable scheme. A manufacturer part number
 * is a useful DESCRIPTIVE column and a poor identity: it is issued by someone
 * other than the supplier, so scoping it to the supplier's DID would assert an
 * authority they do not have.
 */
const IMPORTABLE_SCHEMES: ReadonlySet<string> = new Set(['gtin', 'sku']);

export type ImportRefusal =
  | 'unknown_column'
  | 'missing_required'
  | 'unknown_unit'
  | 'unknown_scheme'
  | 'bad_quantity'
  | 'bad_integer'
  | 'duplicate_identifier'
  | 'unknown_variant_parent'
  | 'malformed_csv';

export interface ImportFinding {
  refusal: ImportRefusal;
  /** 1-based row as the supplier sees it in their spreadsheet, header = 1. */
  row: number;
  column?: string;
  detail: string;
}

export interface CatalogImportItem {
  product: ProductRef;
  sku?: string;
  mpn?: string;
  name?: string;
  description?: string;
  category?: string;
  brand?: string;
  unit_code?: string;
  pack_size?: string;
  min_order_quantity?: string;
  lead_time_days?: number;
  variant_of?: ProductRef;
  list_price?: { currency: string; minor_units: string };
}

export type CatalogImport =
  | { ok: true; items: CatalogImportItem[] }
  /** No items. An import is all-or-nothing — see the module note. */
  | { ok: false; findings: ImportFinding[] };

/**
 * A catalog as ROWS, whatever produced them (WS-9.1).
 *
 * §24's acceptance for the connector work is "connector replacement does not
 * change capability semantics", and the only way to make that TRUE rather than
 * tested is to give every connector one normalizer. A spreadsheet and a REST
 * feed differ in how they are read and in nothing else; both arrive here as
 * columns and rows, and `importCatalogRows` decides what a catalog item is.
 *
 * The alternative — a second importer for JSON — would pass its own tests and
 * disagree with this one about a duplicate identifier, an out-of-vocabulary
 * unit, or a variant whose parent is missing. Buyers would then see a
 * different catalog depending on which backend the supplier happened to pick,
 * which is precisely what the acceptance forbids.
 */
export interface CatalogRowSource {
  /**
   * Column names the source declares. A CSV header, or the key union of a
   * JSON feed. Unknown ones are findings against the SHAPE, reported at row 1.
   */
  columns: string[];
  /** `row` is what the supplier sees: a CSV header is row 1, data starts at 2. */
  rows: { row: number; get: (name: string) => string }[];
  /** Faults found while reading the source itself, before any row was typed. */
  parseFindings: ImportFinding[];
}

/**
 * Turn arbitrary records into a row source (WS-9.1, the REST half).
 *
 * Values are STRINGIFIED, never coerced by type: the normalizer's checks are
 * written against text (`DECIMAL`, the integer patterns, the unit vocabulary),
 * and a JSON `1.50` that arrived as a number would otherwise reach them as
 * `1.5` — a different quantity in a unit that allows two fraction digits.
 * Objects and arrays become the empty string rather than `[object Object]`,
 * so a nested value reads as absent instead of as a nonsense identifier.
 */
export function catalogRowsFromRecords(records: Record<string, unknown>[]): CatalogRowSource {
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(key.trim().toLowerCase());
  }
  return {
    columns: [...columns],
    rows: records.map((record, index) => {
      const flat = new Map<string, string>();
      for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'object') continue;
        flat.set(key.trim().toLowerCase(), String(value).trim());
      }
      // +2 so a JSON feed numbers its rows the way a spreadsheet does: the
      // shape is row 1, the first record is row 2. A supplier comparing a
      // finding against their file should not have to know which connector
      // read it.
      return { row: index + 2, get: (name: string): string => flat.get(name) ?? '' };
    }),
    parseFindings: [],
  };
}

/**
 * Split one CSV line, honouring quoted fields and doubled quotes.
 *
 * Hand-written because the alternative is a dependency in a package whose
 * whole point is being auditable, and because the subset a catalog needs is
 * small and closed. Returns null on a line that ends inside a quote, which is
 * the one malformation that cannot be recovered from locally.
 */
function splitCsvLine(line: string): string[] | null {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote is a literal quote; a single one closes the field.
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch ?? '';
    }
  }
  if (quoted) return null;
  out.push(field);
  return out;
}

/** A canonical decimal quantity: digits, optional single fractional part. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,6})?$/;

/**
 * A source that produced neither columns nor rows and said nothing about why.
 *
 * Only a hand-built `CatalogRowSource` can reach this: both parsers report a
 * finding when they read nothing. It exists so a caller that constructs one
 * gets a refusal rather than a successful import of zero items — which would
 * publish an empty full-state snapshot and read to buyers as "this supplier
 * stocks nothing".
 */
const EMPTY_SOURCE_FINDING: ImportFinding[] = [
  { refusal: 'malformed_csv', row: 1, detail: 'the catalog source produced no rows' },
];

function fractionDigits(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

/**
 * Import a CSV catalog.
 *
 * `defaultScheme` decides how a row that names no `scheme` column is read.
 * It is REQUIRED rather than defaulted, because guessing between `gtin` and
 * `sku` picks the product's IDENTITY — and §9.4 says identity is never merged
 * by name, so a wrong guess creates a product that silently is not the one
 * the supplier meant.
 */
export function importCatalogCsv(args: {
  csv: string;
  defaultScheme: 'gtin' | 'sku';
  /**
   * The supplier publishing this catalog. Required because a
   * `manufacturer_sku` reference is only unambiguous when scoped to whoever
   * issued it — two suppliers may both call something `CHAIR-1`.
   */
  supplierDid: string;
}): CatalogImport {
  const source = parseCatalogCsv(args.csv);
  return importCatalogRows({
    source,
    defaultScheme: args.defaultScheme,
    supplierDid: args.supplierDid,
  });
}

/**
 * Read a CSV into rows. Parsing only — nothing here decides what a catalog
 * item is, so a spreadsheet and a REST feed reach the same normalizer.
 */
export function parseCatalogCsv(csv: string): CatalogRowSource {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) {
    return {
      columns: [],
      rows: [],
      parseFindings: [
        { refusal: 'malformed_csv', row: 1, detail: 'expected a header row and at least one row' },
      ],
    };
  }

  const header = splitCsvLine(lines[0] ?? '');
  if (header === null) {
    return {
      columns: [],
      rows: [],
      parseFindings: [{ refusal: 'malformed_csv', row: 1, detail: 'unterminated quote' }],
    };
  }
  const columns = header.map((h) => h.trim().toLowerCase());
  const parseFindings: ImportFinding[] = [];
  const rows: CatalogRowSource['rows'] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const rowNumber = i + 1;
    const cells = splitCsvLine(lines[i] ?? '');
    if (cells === null) {
      parseFindings.push({
        refusal: 'malformed_csv',
        row: rowNumber,
        detail: 'unterminated quote',
      });
      continue;
    }
    rows.push({
      row: rowNumber,
      get: (name: string): string => {
        const at = columns.indexOf(name);
        return at === -1 ? '' : (cells[at] ?? '').trim();
      },
    });
  }

  return { columns, rows, parseFindings };
}

/**
 * Rows become catalog items, or the import refuses.
 *
 * THE ONE NORMALIZER. Every connector reaches this function, which is what
 * makes §24's "connector replacement does not change capability semantics"
 * structurally true rather than merely tested: a duplicate identifier, an
 * out-of-vocabulary unit and a missing variant parent are the same fault
 * whichever backend produced the row.
 */
export function importCatalogRows(args: {
  source: CatalogRowSource;
  defaultScheme: 'gtin' | 'sku';
  supplierDid: string;
}): CatalogImport {
  const findings: ImportFinding[] = [...args.source.parseFindings];
  const columns = args.source.columns;
  if (columns.length === 0 && args.source.rows.length === 0) {
    // Nothing readable at all. The parse findings say why; adding a second
    // explanation here would make one fault look like two.
    return { ok: false, findings: findings.length > 0 ? findings : EMPTY_SOURCE_FINDING };
  }
  columns.forEach((column, index) => {
    if (column !== '' && !KNOWN_COLUMNS.has(column)) {
      // Named, not guessed away. A column the importer silently ignored is a
      // column the supplier believes they published.
      findings.push({
        refusal: 'unknown_column',
        row: 1,
        column,
        detail: `column ${String(index + 1)} is not a catalog field`,
      });
    }
  });

  const items: CatalogImportItem[] = [];
  const seen = new Map<string, number>();

  for (const { row: rowNumber, get } of args.source.rows) {
    const scheme = get('scheme') === '' ? args.defaultScheme : get('scheme');
    if (!IMPORTABLE_SCHEMES.has(scheme)) {
      findings.push({
        refusal: 'unknown_scheme',
        row: rowNumber,
        column: 'scheme',
        detail: `"${scheme}" is not an importable product scheme`,
      });
      continue;
    }
    // The identifier column, or the sku column when the scheme IS sku — a
    // supplier should not have to write the same value twice.
    const identifier = get('identifier') !== '' ? get('identifier') : get(scheme);
    if (identifier === '') {
      findings.push({
        refusal: 'missing_required',
        row: rowNumber,
        column: 'identifier',
        detail: 'every row needs a product identifier',
      });
      continue;
    }

    const key = `${scheme}:${identifier}`;
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      // §9.4: identity is never merged. Two rows claiming one identity is a
      // question only the supplier can answer, so neither is chosen.
      findings.push({
        refusal: 'duplicate_identifier',
        row: rowNumber,
        detail: `${key} already appears on row ${String(firstSeen)}`,
      });
      continue;
    }
    seen.set(key, rowNumber);

    // BUILT AND VALIDATED, not cast. A CSV `sku` becomes a protocol
    // `manufacturer_sku` scoped to this supplier; a `gtin` is global and
    // carries no issuer.
    const product: ProductRef =
      scheme === 'gtin'
        ? { scheme: 'gtin', value: identifier }
        : { scheme: 'manufacturer_sku', value: identifier, issuer_did: args.supplierDid };
    const productError = validateProductRef(product);
    if (productError !== null) {
      findings.push({
        refusal: 'unknown_scheme',
        row: rowNumber,
        column: 'identifier',
        detail: productError,
      });
      continue;
    }
    const item: CatalogImportItem = { product };

    const unit = get('unit_code');
    if (unit !== '') {
      if (unitDef(unit) === undefined) {
        // The §9.2 vocabulary is CLOSED (owner decision, §27 Q4). Accepting an
        // unknown unit here would publish a catalog nobody can price against.
        findings.push({
          refusal: 'unknown_unit',
          row: rowNumber,
          column: 'unit_code',
          detail: `"${unit}" is not in the v1 unit vocabulary`,
        });
        continue;
      }
      item.unit_code = unit;
    }

    let quantityFault = false;
    for (const column of ['pack_size', 'min_order_quantity'] as const) {
      const raw = get(column);
      if (raw === '') continue;
      const def = unit === '' ? undefined : unitDef(unit);
      if (!DECIMAL.test(raw)) {
        findings.push({
          refusal: 'bad_quantity',
          row: rowNumber,
          column,
          detail: `"${raw}" is not a canonical decimal quantity`,
        });
        quantityFault = true;
        continue;
      }
      if (def !== undefined && fractionDigits(raw) > def.scale) {
        // A quantity carrying more precision than its unit allows would round
        // somewhere later, and "somewhere later" is how two implementations
        // come to disagree about how much was ordered.
        findings.push({
          refusal: 'bad_quantity',
          row: rowNumber,
          column,
          detail: `unit "${unit}" allows ${String(def.scale)} fraction digits`,
        });
        quantityFault = true;
        continue;
      }
      item[column] = raw;
    }
    if (quantityFault) continue;

    const lead = get('lead_time_days');
    if (lead !== '') {
      if (!/^(?:0|[1-9][0-9]{0,4})$/.test(lead)) {
        findings.push({
          refusal: 'bad_integer',
          row: rowNumber,
          column: 'lead_time_days',
          detail: `"${lead}" is not a whole number of days`,
        });
        continue;
      }
      item.lead_time_days = Number(lead);
    }

    const priceMinor = get('list_price_minor_units');
    if (priceMinor !== '') {
      const currency = get('currency');
      if (!/^-?(?:0|[1-9][0-9]{0,17})$/.test(priceMinor) || currency === '') {
        findings.push({
          refusal: 'bad_integer',
          row: rowNumber,
          column: 'list_price_minor_units',
          detail: 'a list price needs integer minor units and a currency',
        });
        continue;
      }
      item.list_price = { currency, minor_units: priceMinor };
    }

    for (const column of ['sku', 'mpn', 'name', 'description', 'category', 'brand'] as const) {
      const raw = get(column);
      if (raw !== '') item[column] = raw;
    }

    const parent = get('variant_of');
    if (parent !== '') {
      const parentRef: ProductRef =
        scheme === 'gtin'
          ? { scheme: 'gtin', value: parent }
          : { scheme: 'manufacturer_sku', value: parent, issuer_did: args.supplierDid };
      const parentError = validateProductRef(parentRef);
      if (parentError !== null) {
        findings.push({
          refusal: 'unknown_scheme',
          row: rowNumber,
          column: 'variant_of',
          detail: parentError,
        });
        continue;
      }
      item.variant_of = parentRef;
    }

    items.push(item);
  }

  // Variant parents are resolved AFTER every row is read, because a
  // spreadsheet may list a variant above its parent and refusing on row order
  // would be an accident of how the supplier sorted their file.
  const identities = new Set(items.map((item) => `${item.product.scheme}:${item.product.value}`));
  items.forEach((item, index) => {
    const parent = item.variant_of;
    if (parent === undefined) return;
    if (!identities.has(`${parent.scheme}:${parent.value}`)) {
      findings.push({
        refusal: 'unknown_variant_parent',
        // +2: the header is row 1 and `items` is zero-based. Only exact for an
        // import with no skipped rows, which is the only case that reaches
        // here — a run with findings never returns items at all.
        row: index + 2,
        column: 'variant_of',
        detail: `no row declares ${parent.scheme}:${parent.value}`,
      });
    }
  });

  // ALL OR NOTHING. A partial import publishes a full-state snapshot that
  // silently omits products (§10.2), and the omission is invisible in the
  // record — buyers see a supplier who does not stock the thing.
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, items };
}
