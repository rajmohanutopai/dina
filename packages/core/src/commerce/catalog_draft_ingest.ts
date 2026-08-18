/**
 * The entry point §10 item 8 says is missing: rows go in, a stored draft
 * comes out.
 *
 * `CatalogRowSource` was already "the correct seam" by shape, with
 * `parseCatalogCsv` and `catalogRowsFromRecords` producing one and nothing
 * behind them — a funnel with no bucket. This is the bucket. It runs the
 * import, assembles the items, seeds per-field provenance and writes a draft
 * in `created`, which is where §6's state machine picks it up.
 *
 * TWO THINGS THE CALLER DOES NOT GET TO SAY, both for the same reason: a
 * marker that exempts something from confirmation is worth forging.
 *
 *   - the draft's PROVENANCE CLASS, which each entry point fixes for itself;
 *   - per-field PROVENANCE, derived from `CATALOG_FIELD_ORIGIN` — the
 *     assembler's own record of what it minted.
 *
 * Neither appears in any request body.
 */

import {
  type AssemblyFinding,
  type AssemblyIdentity,
  type AssemblySettings,
  type AssemblyStamp,
  CATALOG_FIELD_ORIGIN,
  assembleCatalogItems,
} from './catalog_assembler';
import {
  type CatalogImport,
  type CatalogRowSource,
  type ImportFinding,
  importCatalogRows,
} from './catalog_import';

import type {
  CatalogDraft,
  CatalogDraftRepository,
  DraftRow,
  FieldProvenance,
  ProvenanceClass,
} from './catalog_draft_store';
import type { CatalogItem } from '@dina/commerce-protocol';

/** Why a draft was not created. Findings carry the detail. */
/**
 * Ingress always produces a draft now (§5 step 3). The shape stays a result
 * type because the ROUTE still refuses before reaching here — missing
 * settings, a caller that is not this node — and those refusals are about the
 * request, not about the rows.
 */
export interface IngressOutcome { ok: true; draft: CatalogDraft }

export interface DraftIngressDeps {
  drafts: CatalogDraftRepository;
  now: () => number;
  /** Injected so the id is not minted from a clock this module cannot fake. */
  newDraftId: () => string;
  /**
   * Minted ONCE, here, and stored — never re-derived.
   *
   * §10 item 8: a rebuild that re-mints either of these moves
   * `snapshot_digest` out from under the owner's approval. `prepare` reads
   * them back off the draft rather than calling this again.
   */
  stamp: () => AssemblyStamp;
}

/**
 * Seed the provenance map for one assembled item.
 *
 * Only fields the item actually HAS are recorded: `unconfirmedFields` walks
 * `Object.keys(item)`, so an entry for an absent optional field would be a row
 * in the map that nothing ever reads.
 */
function seedProvenance(
  item: CatalogItem,
  provenanceClass: ProvenanceClass,
): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {};
  for (const field of Object.keys(item)) {
    if (provenanceClass !== 'model_derived') {
      // NOT AN EXEMPTION THIS FUNCTION GRANTS — the class already carries it.
      // No model produced these values, so there is nothing for a person to
      // vouch for, and `confirm` skips the whole check for these classes
      // anyway. Writing the state down keeps the map readable rather than
      // leaving a blank that `unconfirmedFields` would read as `proposed`.
      out[field] = 'not_model_derived';
      continue;
    }
    const origin = CATALOG_FIELD_ORIGIN[field as keyof CatalogItem] ?? 'row';
    out[field] = origin === 'minted' ? 'not_model_derived' : 'proposed';
  }
  return out;
}

/**
 * Flatten a row source into data.
 *
 * `CatalogRowSource` hands each row a `get(name)` CLOSURE, and a closure does
 * not survive `JSON.stringify` — storing the source's own shape wrote
 * `{"row":2}` per row and lost every value the model read, with the column
 * populated and the array length right. §10 item 8 wants the extracted rows
 * durable, so they are read out here, once, while the closure still exists.
 *
 * Cells sit under their own key rather than beside the line number, because a
 * source may legitimately have a column called `row` and the two must not be
 * able to overwrite each other.
 */
function materialiseRows(source: CatalogRowSource): DraftRow[] {
  const columns = source.columns.filter((c) => c !== '');
  return source.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const column of columns) cells[column] = row.get(column);
    return { row: row.row, cells };
  });
}

/**
 * Rebuild a row source from the rows a draft is holding.
 *
 * Repair (§5 step 4) edits stored rows and re-imports them, so the source has
 * to come back from the draft rather than from the original request — which is
 * gone. Line numbers are preserved because they are what the seller sees, and
 * a finding that moved rows would point at the wrong line.
 */
export function sourceFromDraftRows(rows: readonly DraftRow[]): CatalogRowSource {
  const columns = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.cells)) columns.add(key);
  return {
    columns: [...columns],
    rows: rows.map((row) => ({ row: row.row, get: (name: string) => row.cells[name] ?? '' })),
    parseFindings: [],
  };
}

/**
 * Import and assemble whatever the rows currently say.
 *
 * Returns findings INSTEAD OF refusing, because §5 puts repair between the
 * draft and the assembly: rows that do not yet import are the normal first
 * state of a photographed price list, not an error to throw away.
 */
export function assembleFromRows(args: {
  rows: readonly DraftRow[];
  defaultScheme: 'gtin' | 'sku';
  identity: AssemblyIdentity;
  settings: AssemblySettings;
  stamp: AssemblyStamp;
}): { items: CatalogItem[]; findings: (ImportFinding | AssemblyFinding)[] } {
  const imported = importCatalogRows({
    source: sourceFromDraftRows(args.rows),
    defaultScheme: args.defaultScheme,
    supplierDid: args.identity.supplierDid,
    // The seller's own currency, so a photographed price list that names one
    // nowhere still imports. The assembler overrides the row's currency with
    // this same value anyway — without it the row was refused before ever
    // reaching the code that would have supplied it.
    fallbackCurrency: args.settings.tradingCurrency,
  });
  if (!imported.ok) return { items: [], findings: [...imported.findings] };

  const assembly = assembleCatalogItems({
    items: imported.items,
    identity: args.identity,
    settings: args.settings,
    stamp: args.stamp,
  });
  if (!assembly.ok) return { items: [], findings: [...assembly.findings] };
  return { items: [...assembly.items], findings: [] };
}

/**
 * Persist the extracted rows, then assemble whatever they support.
 *
 * §5 IS EXPLICIT ABOUT THE ORDER: step 3 persists "rows plus findings as a
 * draft", step 4 is repair, step 5 assembles. An earlier version ran import
 * and assembly FIRST and stored nothing unless both succeeded — so a photo
 * with one unreadable cell produced no draft at all, and the repair step it
 * was supposed to feed had nothing to repair. The findings came back in an
 * HTTP response and the durable `findings` column no code could populate.
 *
 * A draft with findings is not publishable and does not need to be: `confirm`
 * refuses a draft with no items, so an unrepaired draft cannot advance. What
 * it can do is exist, which is the whole point of step 3.
 */
export function createCatalogDraft(
  deps: DraftIngressDeps,
  args: {
    catalogId: string;
    source: CatalogRowSource;
    defaultScheme: 'gtin' | 'sku';
    identity: AssemblyIdentity;
    settings: AssemblySettings;
    provenanceClass: ProvenanceClass;
    /** §5 — which model read these rows, where one did. */
    extraction: { model: string; schemaVersion: string } | null;
    /**
     * §2.1 (photo lanes): the extraction chain — manifest, commitment
     * digest, binding record — minted by the photo-extract path before the
     * draft exists. Null on every other lane.
     */
    photoExtraction?: CatalogDraft['photoExtraction'];
  },
): IngressOutcome {
  const rows = materialiseRows(args.source);
  const stamp = deps.stamp();
  const { items, findings } = assembleFromRows({
    rows,
    defaultScheme: args.defaultScheme,
    identity: args.identity,
    settings: args.settings,
    stamp,
  });

  const provenance: Record<string, Record<string, FieldProvenance>> = {};
  items.forEach((item, index) => {
    provenance[String(index)] = seedProvenance(item, args.provenanceClass);
  });

  const at = deps.now();
  const draft: CatalogDraft = {
    draftId: deps.newDraftId(),
    catalogId: args.catalogId,
    state: 'created',
    provenanceClass: args.provenanceClass,
    defaultScheme: args.defaultScheme,
    extraction: args.extraction,
    photoExtraction: args.photoExtraction ?? null,
    publishClaim: null,
    contentRevision: 1,
    rows,
    findings,
    provenance,
    items,
    generatedAtIso: stamp.generatedAtIso,
    itemRevision: stamp.itemRevision,
    receipt: null,
    held: null,
    approval: null,
    publication: null,
    createdAtMs: at,
    updatedAtMs: at,
  };
  deps.drafts.put(draft);
  return { ok: true, draft };
}
