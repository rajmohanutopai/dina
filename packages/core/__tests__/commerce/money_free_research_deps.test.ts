/**
 * §5.B2 acceptance guard — the money-free research components must keep working
 * with the Commerce Pack (money engine) uninstalled. That only holds if they do
 * not depend on the money engine in the first place. This locks that in: the
 * research / catalog / offer / comparison modules the consumer loop reuses, and
 * the coordinate-and-close tender / quote / decline path, reach NOTHING in the
 * money engine (the khata ledger, the trade documents, the fold, revenue share,
 * Tally export) — not by import, not transitively, and not through the money
 * line (`money()`), the one door §5.B1 Cut 3 opened.
 *
 * Written BEFORE the Group B extraction so it both proves the invariant today
 * (the research path is already cleanly separable — which is what makes the
 * extraction possible) and guards against a regression that couples them while
 * the money engine is being moved out.
 *
 * `tender.ts`, `buyer_quote_request.ts`, `decline_documents.ts` and
 * `buyer_response.ts` are on the guarded path: they read declines through the
 * kernel `declineDocuments` store, never the money ledger. `buyer_response`
 * verifies quotes, statuses, acknowledgements and declines; delivery / payment
 * ingress lives in `trade_ingress.ts`, which is money.
 *
 * `runtime.ts` is the composition root: it CONSTRUCTS the money stores behind
 * `money()`, so it is the one sink the closure walk stops at. A research module
 * may reach the runtime for the money-free fields; it may not call `money()`.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const COMMERCE_DIR = join(__dirname, '..', '..', 'src', 'commerce');

// The money-free commerce components that must keep working with the Commerce
// Pack uninstalled.
const RESEARCH_MODULES = [
  'offer_ranking',
  'comparison_card',
  'catalog_offers',
  'procurement_service',
  'product_evidence',
  'quote_fanout',
  'price_divergence',
  'tender',
  'buyer_quote_request',
  'decline_documents',
  'buyer_response',
];

// The money engine (Group B extraction set): core modules by import path, the
// package the pack will move into, and the protocol money wire by the symbols
// it exports (those arrive through the `@dina/commerce-protocol` barrel, so a
// path check alone would miss them).
const MONEY_CORE_MODULES = [
  'trade_ledger',
  'trade_ledger_service',
  'trade_ingress',
  'trade_readers',
  'trade_inbox',
  'trade_spool',
  'money_rehydrate',
  'tally_export',
  'revshare_ledger',
  'revshare_service',
];
const MONEY_PACKAGES = ['@dina/commerce-pack'];
const MONEY_WIRE_SYMBOLS = [
  // trade documents (types + readers/validators)
  'DeliveryNote',
  'DeliveryReceipt',
  'PaymentNote',
  'PaymentAcknowledgement',
  'readDeliveryNote',
  'readDeliveryReceipt',
  'readPaymentNote',
  'readPaymentAcknowledgement',
  'validateDeliveryNote',
  'validateDeliveryReceipt',
  'validatePaymentNote',
  'validatePaymentAcknowledgement',
  // the fold + dues
  'computeTradeFold',
  'deriveDues',
  // revenue share
  'AgreementProposal',
  'AgreementDecision',
  'AgreementTermination',
  'SettlementNote',
  'SettlementAcknowledgement',
  'computeRevshareFold',
  // the ingress + the money line
  'applyInboundTradeDocument',
  'drainTradeSpool',
];
/** The composition root — reachable, but never asked for money. */
const SINK = 'runtime';

/** Code only: a symbol named in a comment is prose, not a dependency. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Import specifiers + (comment-free) source of one commerce module. */
function importsOf(moduleName: string): { paths: string[]; source: string } {
  const source = stripComments(readFileSync(join(COMMERCE_DIR, `${moduleName}.ts`), 'utf8'));
  const paths: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) paths.push(m[1]);
  return { paths, source };
}

/** A `./x` sibling import → module name `x`, else null. */
function sibling(specifier: string): string | null {
  const m = /^\.\/([a-z_]+)$/.exec(specifier);
  return m === null ? null : m[1];
}

/** Every sibling module reachable from `root` inside src/commerce, stopping at the sink. */
function closureOf(root: string): string[] {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const mod = stack.pop() as string;
    if (seen.has(mod) || mod === SINK) continue;
    seen.add(mod);
    for (const p of importsOf(mod).paths) {
      const next = sibling(p);
      if (next !== null && !seen.has(next)) stack.push(next);
    }
  }
  seen.delete(root);
  return [...seen].sort();
}

describe('§5.B2 — the guard cannot go quiet', () => {
  it('every money module it names exists (a rename or a move fails here, not silently)', () => {
    for (const mm of MONEY_CORE_MODULES) {
      expect(existsSync(join(COMMERCE_DIR, `${mm}.ts`))).toBe(true);
    }
  });
});

describe('§5.B2 — money-free research components do not reach the money engine', () => {
  for (const mod of RESEARCH_MODULES) {
    it(`${mod} imports no money-engine module, package, or wire symbol`, () => {
      const { paths, source } = importsOf(mod);

      const offendingPaths = paths.filter(
        (p) =>
          MONEY_CORE_MODULES.some((mm) => p === `./${mm}` || p.endsWith(`/${mm}`)) ||
          MONEY_PACKAGES.some((pkg) => p === pkg || p.startsWith(`${pkg}/`)),
      );
      expect(offendingPaths).toEqual([]);

      // The protocol money wire arrives via the barrel — catch it by symbol.
      const offendingSymbols = MONEY_WIRE_SYMBOLS.filter((sym) =>
        new RegExp(`\\b${sym}\\b`).test(source),
      );
      expect(offendingSymbols).toEqual([]);

      // The money line: a research module never asks the runtime for money.
      expect(/\.money\s*\(/.test(source)).toBe(false);
    });

    it(`${mod} reaches no money-engine module transitively (closure inside src/commerce, sink = runtime)`, () => {
      const closure = closureOf(mod);
      const offending = closure.filter((m) => MONEY_CORE_MODULES.includes(m));
      expect(offending).toEqual([]);
      // Nor does anything in the closure carry the money wire or call money().
      for (const m of closure) {
        const { source } = importsOf(m);
        const symbols = MONEY_WIRE_SYMBOLS.filter((sym) => new RegExp(`\\b${sym}\\b`).test(source));
        expect({ module: m, symbols }).toEqual({ module: m, symbols: [] });
        expect({ module: m, callsMoney: /\.money\s*\(/.test(source) }).toEqual({ module: m, callsMoney: false });
      }
    });
  }
});
