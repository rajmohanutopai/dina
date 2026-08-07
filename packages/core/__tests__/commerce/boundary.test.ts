/**
 * The commerce aggregate boundary, enforced statically (ARCH-0 / WS-0.5).
 *
 * `QuoteFamily.hold()` is worthless while `holdUse()` stays callable, and
 * `StatusChain.advance()` is worthless while `casAdvance()` does. Behavioural
 * tests cannot express that: they test what the code DOES, and the risk here
 * is what a future caller COULD do. A grep proved nobody bypassed the
 * aggregates today; it proved nothing about the design.
 *
 * So the rule is asserted over the source itself. It fails on the commit that
 * reintroduces a bypass, not on the incident that exploits one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const COMMERCE_SRC = path.join(__dirname, '..', '..', 'src', 'commerce');
const CORE_SRC = path.join(__dirname, '..', '..', 'src');

/** Raw persistence primitives that must not be reachable from a caller. */
const RAW_MUTATORS = [
  'registerHead',
  'casAdvanceHead',
  'holdUse',
  'settleUse',
  'voidUnexpired',
  'activeUseCount',
  'initGenesis',
  'casAdvance',
  'setFence',
];

/** Files allowed to name them: the repositories themselves and their owners. */
const OWNERS = new Set([
  'quote_ledger.ts',
  'quote_family.ts',
  'status_heads.ts',
  'status_chain.ts',
  'order_refs.ts',
  'commerce_order.ts',
]);

function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? tsFiles(path.join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [path.join(dir, e.name)]
          : [],
    );
}

/** Strip comments so prose ABOUT a rule is not mistaken for a call to it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('commerce aggregate boundary', () => {
  it('no production file outside an owner calls a raw persistence mutator', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      if (OWNERS.has(path.basename(file))) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      for (const mutator of RAW_MUTATORS) {
        // `.mutator(` — a call through some receiver, which is exactly the
        // bypass shape. A bare identifier could be an unrelated local.
        if (new RegExp(`\\.${mutator}\\s*\\(`).test(body)) {
          offenders.push(`${path.basename(file)} calls .${mutator}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the mutable per-repository globals are gone', () => {
    // Five setters and five getters used to hand the raw repositories to any
    // caller that asked. They are replaced by one composition root.
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      const body = code(fs.readFileSync(file, 'utf8'));
      if (/export function (get|set)Commerce\w*Repository\s*\(/.test(body)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('commerce engines depend on aggregate stores, never on raw repositories', () => {
    const engines = ['admission.ts', 'lifecycle_engine.ts', 'epoch_service.ts'];
    for (const name of engines) {
      const body = code(fs.readFileSync(path.join(COMMERCE_SRC, name), 'utf8'));
      // A dependency FIELD typed as a raw repository is the bypass; a type
      // import for a signature is not, so match the declaration shape.
      expect(body).not.toMatch(/^\s+\w+:\s*Commerce\w*(Ledger|Head|Ref)Repository;/m);
    }
  });

  it('only the composition root constructs SQLite commerce repositories', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(CORE_SRC)) {
      if (path.basename(file) === 'runtime.ts' && file.includes('commerce')) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      const m = body.match(/new SQLiteCommerce\w+Repository\s*\(/g);
      if (m) offenders.push(`${path.basename(file)} (${m.length})`);
    }
    expect(offenders).toEqual([]);
  });
});
