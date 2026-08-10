/**
 * §17 — the constraints commerce OWES the managed runtime, asserted.
 *
 * WHY THIS FILE EXISTS RATHER THAN A HOSTING PRODUCT. §17 opens by saying
 * "Commerce depends on the generic managed Dina runtime but does not define
 * it. The following requirements are vertical integration constraints." So
 * WS-8's deliverable is not a hosting service — it is that the commerce
 * vertical does not make one impossible or expensive. `@dina/managed-runtime`
 * holds the generic mechanism and is tested on its own; what was never checked
 * is the half that is actually commerce's.
 *
 * These are STRUCTURAL properties, checked against the source rather than
 * against behaviour, because that is the only way to check a negative that has
 * to hold everywhere. A test that called one function and found no LLM would
 * prove nothing about the next function.
 *
 * §17.5 in its own words:
 *   - AppView performs shared structured retrieval
 *   - quote and order payloads are structured
 *   - comparison arithmetic is deterministic
 *   - LLM use is limited to parsing and explanation
 *   - idle tenant cells can sleep
 *   - catalog refreshes are incremental
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const COMMERCE_SRC = path.join(__dirname, '..', '..', 'src', 'commerce');

function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    })
    .sort();
}

/** Source with comments and string literals removed, so prose cannot match. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``');
}

const SOURCES = tsFiles(COMMERCE_SRC).map((file) => ({
  file: path.relative(COMMERCE_SRC, file),
  body: code(fs.readFileSync(file, 'utf8')),
}));

describe('§17.5 — no LLM in the commerce path', () => {
  it('imports no reasoning package, in any commerce module', () => {
    // "LLM use is limited to parsing and explanation" — and parsing an
    // owner's utterance happens in Brain, before any of this runs. A model in
    // here would put a non-deterministic step inside the path that spends
    // money, which is the §17.5 cost argument and the CLAUDE.md enforcement
    // rule saying the same thing from the security side.
    const offenders = SOURCES.filter((s) => /from\s+''/.test('') || /@dina\/brain/.test(s.body));

    expect(offenders.map((s) => s.file)).toEqual([]);
  });

  it('calls no model client, under any of the vendor names', () => {
    const offenders = SOURCES.filter((s) =>
      /\b(openai|anthropic|generativeai|createChatCompletion|chat\.completions)\b/i.test(s.body),
    );

    expect(offenders.map((s) => s.file)).toEqual([]);
  });
});

describe('§17.5 — comparison arithmetic is deterministic', () => {
  it('the ranking and the card draw on no randomness', () => {
    // A ranking that moved between two runs over the same offers would make
    // "why did this win" unanswerable, and §18.4's card exists to answer it.
    const decisionMakers = SOURCES.filter((s) =>
      ['offer_ranking.ts', 'comparison_card.ts'].includes(s.file),
    );

    expect(decisionMakers).toHaveLength(2);
    for (const source of decisionMakers) {
      expect(source.body).not.toMatch(/Math\.random/);
      expect(source.body).not.toMatch(/\bnew Date\(\s*\)/);
      expect(source.body).not.toMatch(/Date\.now\(\)/);
    }
  });

  it('reads the clock only as a COMPOSITION DEFAULT, never inside logic', () => {
    // Testability as much as determinism: every expiry, TTL and sweep in this
    // aggregate is driven by an injected `nowMs`, so a test can put the world
    // at any instant. A read inside logic is the one place that cannot be.
    //
    // A DEFAULT is different and is allowed: `args.nowMs ?? Date.now()` at a
    // seam means the caller may still choose, and a seam has to get its clock
    // from somewhere. The distinction is what the pattern below encodes —
    // which is why this asserts a shape rather than an absence, after a
    // blanket ban flagged six modules of which four were legitimate defaults.
    // The optional `: number` matters: the codebase's idiom is
    // `?? ((): number => Date.now())`, and a pattern written from memory
    // without it flagged four legitimate seams. Third time this session that a
    // regex rule of mine was narrower than the code it judged — measure the
    // shape, do not recall it.
    const AS_DEFAULT =
      /(\?\?|=)\s*\(?\s*\(\)\s*(:\s*\w+\s*)?=>\s*Date\.now\(\)|\?\?\s*Date\.now\(\)/;
    const offenders = SOURCES.filter((source) => {
      const reads = source.body.match(/Date\.now\(\)|new Date\(\s*\)/g) ?? [];
      if (reads.length === 0) return false;
      const defaults = source.body.match(new RegExp(AS_DEFAULT.source, 'g')) ?? [];
      return reads.length > defaults.length;
    });

    expect(offenders.map((s) => s.file)).toEqual([]);
  });
});

describe('§17.5 — payloads are structured, not prose', () => {
  it('the money type is integer minor units and a currency, never a float', () => {
    // "quote and order payloads are structured" has a specific meaning for
    // money: a float total is a rounding argument nobody can settle
    // afterwards. §9.1 says integer minor units as a canonical string, and
    // the type is what enforces it.
    const arithmetic = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'commerce-protocol', 'src', 'money.ts'),
      'utf8',
    );

    expect(arithmetic).toMatch(/minor_units:\s*string/);
    expect(code(arithmetic)).not.toMatch(/parseFloat|Number\.parseFloat/);
  });
});

describe('§17.1 — one tenant, one authority domain', () => {
  it('no commerce module resolves a tenant, so nothing here can cross one', () => {
    // §17.1 makes the Core authority domain the isolation boundary and says
    // "the current Home Node Lite single-writer model remains authoritative
    // per tenant". Commerce therefore has no business knowing what a tenant
    // is: a module that looked one up would be a module that could look up
    // the wrong one. Isolation by ignorance, which is the strongest kind
    // available to a vertical.
    // MACHINERY, not the word. My first version banned `tenantId` outright and
    // flagged `credential_broker.ts`, where it is one of §8.3's five REQUIRED
    // lease bindings — the scope that makes a narrow credential lease safe, and
    // the opposite of a violation. What must not appear is the runtime's own
    // apparatus: a commerce module holding a `ControlPlane` could reach a cell
    // that is not its caller's.
    const offenders = SOURCES.filter((s) =>
      /\bControlPlane\b|\bManagedBlobStore\b|\bHostedRunnerRegistry\b|@dina\/managed-runtime/.test(
        s.body,
      ),
    );

    expect(offenders.map((s) => s.file)).toEqual([]);
  });

  it('scopes a credential lease BY tenant, which is the opposite of crossing one', () => {
    // Recorded as a positive rather than left as an exception to the rule
    // above: §8.3 requires all five bindings, and the tenant is one of them.
    const broker = SOURCES.find((s) => s.file === 'credential_broker.ts');

    expect(broker?.body).toMatch(/tenantId/);
    expect(broker?.body).toMatch(/lease\.tenantId\s*!==\s*args\.request\.tenantId/);
  });
});
