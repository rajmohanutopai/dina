/**
 * The SKU minting POLICY (PHOTO_COMMERCE_LANES_DESIGN §4.2).
 *
 * THE PACK'S HALF of the mint decision: which rows mint, what shape, when.
 * It sits beside `catalog_import.ts` because minting is commerce
 * normalization — the lane doc's §9 ownership rule — and Core contributes
 * only the durable atomic reservation primitive (`sku_ledger.ts`).
 *
 * WHEN THIS RUNS: at repair time on a photo-derived draft, BEFORE
 * `importCatalogRows` sees the rows. The pickle seller's jars have never
 * had a SKU; without the mint every identifier-less row lands in repair as
 * `missing_required` with no way out but inventing identifiers by hand.
 *
 * WHAT IT DOES, per row:
 *
 *   - an identifier-less row under the `sku` scheme MINTS one (`P-0001`,
 *     …) — written into the cell like any other value, provenance
 *     `not_model_derived` because no model produced it, and NEVER
 *     re-derived. GTIN rows never mint: a GTIN is a global identifier and
 *     minting one would claim a namespace this supplier does not own.
 *   - EVERY identifier entering the draft — minted, inherited, edited, or
 *     source-provided — atomically CLAIMS the issuer ledger under the
 *     row's immutable `assignment_id` (minted once, on the row entry, so
 *     reordering leaves assignments untouched). A claim held by another
 *     assignment refuses with an `identifier_claimed` finding naming the
 *     owning catalog.
 *
 * The caller wraps this in ONE transaction with the draft mutation that
 * stores the returned rows — assignment creation, the claims, and the
 * draft write commit together, so a crash between them is unobservable.
 */

import { newAssignmentId } from './sku_ledger';

import type { DraftRow } from './catalog_draft_store';
import type { ImportFinding } from './catalog_import';
import type { SkuLedgerRepository } from './sku_ledger';

export interface SkuMintResult {
  /** The rows, with minted values filled in and assignment ids attached. */
  rows: DraftRow[];
  /** Claim refusals, as repair findings beside the importer's own. */
  findings: ImportFinding[];
  /** True when any cell changed — the caller bumps the content revision. */
  changed: boolean;
}

/**
 * Which cell holds the row's identity, mirroring the importer's own
 * lookup: the `identifier` column, or the scheme column when that is
 * where the supplier wrote it.
 */
function identifierOf(row: DraftRow, scheme: string): { column: string; value: string } {
  const explicit = row.cells.identifier ?? '';
  if (explicit !== '') return { column: 'identifier', value: explicit };
  return { column: scheme, value: row.cells[scheme] ?? '' };
}

export function applySkuMint(args: {
  ledger: SkuLedgerRepository;
  issuerDid: string;
  catalogId: string;
  draftId: string;
  defaultScheme: 'gtin' | 'sku';
  rows: readonly DraftRow[];
  nowMs: number;
}): SkuMintResult {
  const findings: ImportFinding[] = [];
  const out: DraftRow[] = [];
  let changed = false;

  for (const row of args.rows) {
    const scheme = (row.cells.scheme ?? '') === '' ? args.defaultScheme : (row.cells.scheme ?? '');
    const { column, value } = identifierOf(row, scheme);
    const next: DraftRow = { ...row, cells: { ...row.cells } };

    if (scheme !== 'sku') {
      // GTIN (or an unknown scheme the importer will refuse on its own):
      // nothing to mint, nothing to claim — the ledger scopes supplier
      // identities, and a GTIN is not one.
      out.push(next);
      continue;
    }

    // The immutable identity, minted ONCE. An existing id is never
    // replaced — replacing it would fork the product (§9.4).
    if (next.assignmentId === undefined) {
      next.assignmentId = newAssignmentId();
      changed = true;
    }

    let identifier = value;
    if (identifier === '') {
      // The mint. Allocation skips every claimed value, so this can never
      // issue a value a photographed row already carries.
      identifier = args.ledger.mintNextValue(args.issuerDid, 'manufacturer_sku');
      next.cells[column === 'identifier' ? 'sku' : column] = identifier;
      changed = true;
    }

    const claim = args.ledger.claim({
      issuerDid: args.issuerDid,
      scheme: 'manufacturer_sku',
      value: identifier,
      assignmentId: next.assignmentId,
      catalogId: args.catalogId,
      draftId: args.draftId,
      nowMs: args.nowMs,
    });
    if (claim.outcome === 'refused') {
      findings.push({
        refusal: 'identifier_claimed',
        row: row.row,
        column,
        detail:
          claim.owningCatalogId === args.catalogId
            ? `"${identifier}" already belongs to another product in this catalog`
            : `"${identifier}" belongs to a product in catalog "${claim.owningCatalogId}" — a photo-lane product lives in one catalog`,
      });
    }
    out.push(next);
  }

  return { rows: out, findings, changed };
}
