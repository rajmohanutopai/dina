/**
 * THE MONEY LINE, AS AN IMPORT GRAPH (RESEARCHER_KERNEL_ARCHITECTURE §5.B1,
 * §5.B2).
 *
 * The money line is already enforced at RUNTIME: `runtime.money()` resolves
 * from an `active` first-party Commerce Pack, money-only capabilities answer
 * a typed `unavailable` when the pack is absent or paused, and the money-free
 * decline path keeps its own kernel store. What that check cannot say is
 * whether the money engine could actually LEAVE — and B1 is the physical
 * extraction, which a single stray `import` from the kernel blocks.
 *
 * So the set is enumerated here and the graph is asserted over the source.
 * Two things follow, and they matter for different reasons:
 *
 *   §5.B2's GUARD, made static. The money-free research and catalog
 *   machinery — `offer_ranking`, `procurement_service`, `comparison_card`,
 *   `product_evidence`, `quote_fanout`, `reconciliation_service` (the name
 *   trap: it is the money-FREE order close), and the whole catalog family —
 *   must import no money module, because a consumer has to search offers
 *   with the money plugin uninstalled. A behavioural test proves it works
 *   today; this one fails on the commit that would break it.
 *
 *   B1's REMAINING WORK, made visible. Every edge from the kernel into the
 *   money set is listed below with what it costs. The list is the extraction
 *   plan: when it is empty, the move is a file move. It must only ever
 *   shrink — a new entry is a new coupling, and the test says so by failing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CORE_SRC = path.join(__dirname, '..', '..', 'src');
const COMMERCE_SRC = path.join(CORE_SRC, 'commerce');

/**
 * The money engine: what §5.B1 says moves to the Commerce Pack.
 *
 * `receipts.ts` is deliberately NOT here despite the name — it is the
 * money-FREE commerce receipt store (quote chain, order, acknowledgement,
 * status, cancellation, restore fence), and `reconciliation_service.ts` is
 * not here for the same reason: the spec calls it a name trap, verified in
 * code. The money reconciliation is the khata fold, which lives inside
 * `trade_ledger_service.ts` and does move.
 */
const MONEY_MODULES: ReadonlySet<string> = new Set([
  // The khata: documents, authoring, the fold, the derived balance.
  'trade_ledger.ts',
  'trade_ledger_service.ts',
  'trade_readers.ts',
  'trade_inbox.ts',
  'trade_ingress.ts',
  'trade_spool.ts',
  // The money wire rehydrators, carved out of `rehydrate.ts` so the
  // money-free path reaches no money wire.
  'money_rehydrate.ts',
  // Revenue share: the chain's ledger and its service.
  'revshare_ledger.ts',
  'revshare_service.ts',
  // The khata's outward rails and its accounting export.
  'country_rails.ts',
  'tally_export.ts',
]);

/**
 * The money-free machinery §5.B1 and §5.B2 name as staying in the kernel. A
 * consumer must be able to research, rank, compare and close an order with no
 * money plugin installed, so not one of these may reach a money module.
 */
const KERNEL_MONEY_FREE: readonly string[] = [
  'offer_ranking.ts',
  'procurement_service.ts',
  'comparison_card.ts',
  'product_evidence.ts',
  'quote_fanout.ts',
  'reconciliation_service.ts',
  'catalog_offers.ts',
  'catalog_assembler.ts',
  'catalog_ingest.ts',
  'catalog_publisher.ts',
  'decline_documents.ts',
  'tender.ts',
  'buyer_response.ts',
];

/**
 * The edges that still cross the line, and what each one costs to cut. This
 * list is B1's remaining work — every entry is a reason the money engine
 * cannot simply be moved to its own package today.
 */
const REMAINING_COUPLINGS: Readonly<Record<string, string>> = {
  // The barrel re-exports the money modules along with everything else.
  // Cost: the move rewrites it, nothing more — a re-export is not a caller.
  'commerce/index.ts':
    're-export only; the barrel follows the files',
  // The composition seam. `runtime.ts` CONSTRUCTS the money stores
  // (`SQLiteTradeDocumentRepository`, the revshare ledger, the spool) and
  // registers the inbound ingress. Cost: the stores become injected rather
  // than constructed, so the two composition roots pass what the pack owns.
  'commerce/runtime.ts':
    'constructs the money stores; the move makes them injected',
  // The money ROUTES live inside the 6,450-line commerce route file beside
  // the money-free ones. Cost: carve `/v1/commerce/trade/*` and the revenue
  // -share routes into their own registrar, which the roots call separately.
  'server/routes/commerce.ts':
    'money routes share a file with money-free ones; carve them out',
};

function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? tsFiles(path.join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [path.join(dir, entry.name)]
          : [],
    );
}

/** Which money modules this file imports, by basename. */
function moneyImportsOf(file: string): string[] {
  const body = fs.readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const match of body.matchAll(/from '([^']+)'/g)) {
    const base = `${match[1].split('/').pop() ?? ''}.ts`;
    if (MONEY_MODULES.has(base)) found.add(base);
  }
  return [...found].sort();
}

/** Every file under `src/`, keyed the way the coupling list spells them. */
function relativeKey(file: string): string {
  return path.relative(CORE_SRC, file).split(path.sep).join('/');
}

describe('the money line, as an import graph (§5.B1)', () => {
  const graph = new Map<string, string[]>();
  for (const file of tsFiles(CORE_SRC)) {
    const imports = moneyImportsOf(file);
    if (imports.length > 0) graph.set(relativeKey(file), imports);
  }

  it('every money module named by §5.B1 exists — the set is the extraction manifest', () => {
    for (const name of MONEY_MODULES) {
      expect(fs.existsSync(path.join(COMMERCE_SRC, name))).toBe(true);
    }
  });

  it('only the listed couplings reach into the money engine', () => {
    const offenders: string[] = [];
    for (const [file, imports] of graph) {
      const base = path.basename(file);
      if (MONEY_MODULES.has(base)) continue; // the engine talking to itself
      if (file in REMAINING_COUPLINGS) continue;
      offenders.push(`${file} → ${imports.join(', ')}`);
    }
    // A new name here is a NEW coupling, and every one of them is another
    // thing the extraction has to cut. The list only ever shrinks.
    expect(offenders).toEqual([]);
  });

  it('the listed couplings are all still real — a stale entry hides progress', () => {
    const stale = Object.keys(REMAINING_COUPLINGS).filter((file) => !graph.has(file));
    // An entry that no longer imports anything money-shaped means the
    // coupling was cut and nobody deleted the line. Left in place it makes
    // the remaining work look larger than it is, which is its own kind of
    // wrong answer.
    expect(stale).toEqual([]);
  });

  it('CORE’S TRANSPORT reaches no money module — the D2D pipeline goes through the seam', () => {
    // `receive_pipeline.ts` used to import `commerce/trade_ingress` directly,
    // so Core's own transport held a static edge into the money engine. It
    // now asks `d2d/trade_ingress_seam`, which the money engine registers
    // into at boot: the pack knows about Core, Core does not know about the
    // pack.
    for (const [file] of graph) {
      expect(file.startsWith('d2d/')).toBe(false);
    }
    const seam = fs.readFileSync(path.join(CORE_SRC, 'd2d', 'trade_ingress_seam.ts'), 'utf8');
    expect(seam).toContain('setTradeDocumentIngress');
    const pipeline = fs.readFileSync(path.join(CORE_SRC, 'd2d', 'receive_pipeline.ts'), 'utf8');
    expect(pipeline).toContain('applyInboundTradeDocumentVia');
    expect(pipeline).not.toContain('commerce/trade_ingress');
  });
});

describe('the money-free kernel stays money-free (§5.B2)', () => {
  it.each(KERNEL_MONEY_FREE)('%s imports no money module', (name) => {
    const file = path.join(COMMERCE_SRC, name);
    expect(fs.existsSync(file)).toBe(true);
    // A consumer has to be able to search offers across suppliers with the
    // money plugin uninstalled. One import here and that stops being true —
    // not at runtime, where the money line would answer `unavailable`, but
    // at BUILD, where the kernel would no longer compile without the pack.
    expect(moneyImportsOf(file)).toEqual([]);
  });
});
