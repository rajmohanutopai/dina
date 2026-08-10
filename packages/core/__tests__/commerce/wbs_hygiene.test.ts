/**
 * The WBS is a record of the work, and nothing has ever checked it against the
 * work.
 *
 * WHY THIS FILE EXISTS. This review has now caught `docs/COMMERCE_WBS.md`
 * lying FIVE times — four rows marked PART that were finished, and one marked
 * DONE over code nothing called. That is the same defect the commerce code
 * keeps producing, one level up: a rule nobody evaluates. The row is what a
 * reader trusts when deciding what is left to build, so a stale row is not
 * cosmetic — it sends the next person to re-derive a conclusion already
 * reached, or worse, to trust a claim that stopped being true.
 *
 * WHAT IS AND IS NOT CHECKABLE HERE. Whether a row's PROSE is true of the code
 * is not mechanically decidable, and pretending otherwise would produce a
 * check that passes while the document drifts. Two things ARE decidable, and
 * they are exactly the two failures actually observed:
 *
 *   1. A row marked PART that names no gap. This is how row 3.8 sat stale: it
 *      read as a complete implementation, ended on "2 further mutations
 *      killed", and carried no statement of anything outstanding. A PART with
 *      no gap is indistinguishable from a finished row somebody forgot.
 *   2. A cited repo path that does not exist. A row pointing at a renamed or
 *      deleted file is a row whose evidence cannot be followed.
 *
 * THE PATTERN BELOW IS DELIBERATELY BROAD, and that is a scar. My first
 * version matched only `Open:` and flagged six rows that all stated their gaps
 * perfectly well — as "Still open:", "stays open", "out of commerce's scope".
 * Four times this session a pattern of mine has been narrower than the thing
 * it judged. A doc check that cries wolf gets deleted, and then nothing checks
 * the document at all, so the rule is written to catch the row that says
 * NOTHING rather than to police how a gap is phrased.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const WBS = path.join(REPO_ROOT, 'docs', 'COMMERCE_WBS.md');

const STATUSES = ['**DONE**', '**PART**', '**TODO**', '**BLOCKED**'] as const;

interface Row {
  id: string;
  title: string;
  /** `MISSING` when the row carries no status token at all. */
  status: (typeof STATUSES)[number] | 'MISSING';
  body: string;
  /** How many cells in this row are a status token. Exactly one is legal. */
  statusCells: number;
}

function rows(): Row[] {
  const out: Row[] = [];
  // WHICH TABLE A ROW IS IN, not just what its first cell looks like.
  //
  // Detecting a work row by "first cell is a number" also matched the "Owner
  // decisions folded in" table, whose `#` column runs 1..6. That went unnoticed
  // only because statusless rows were then skipped — one defect hiding another,
  // so removing the skip surfaced six phantom work rows before this.
  //
  // A work table is the one whose header names a `Status` column. Rows are
  // read as work only while that header is in force.
  let inWorkTable = false;
  for (const line of fs.readFileSync(WBS, 'utf8').split('\n')) {
    if (!line.startsWith('|')) {
      if (line.trim() !== '') inWorkTable = false;
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    if (cells.includes('Status') && cells.includes('ID')) {
      inWorkTable = true;
      continue;
    }
    if (!inWorkTable) continue;
    // THE SEPARATOR IS THE ONLY NON-ROW. Every other line inside a Status table
    // is work, so there is no ID GRAMMAR to get wrong — and the grammar was
    // wrong: `^\d+(\.\d+)?[a-c]?$` skipped the real composite row `5.9 / 7.1`,
    // so a row could lose or duplicate its status invisibly. A parser that
    // decides what counts as a row is a parser that can decline to look at the
    // rows most likely to be broken.
    if (/^\|[\s:-]+\|/.test(line)) continue;
    const id = cells[1] ?? '';
    if (id === '') continue;
    // NO `continue` ON A STATUSLESS ROW. Skipping it meant the row most
    // likely to violate "exactly one status" — the one carrying none — was
    // the single row the assertion never saw. A checker that quietly drops
    // its own counterexamples cannot fail.
    const status = STATUSES.find((s) => cells.includes(s));
    // The notes cell is the long one; its position varies across sections.
    const body = cells.reduce((a, b) => (b.length > a.length ? b : a), '');
    out.push({
      id,
      title: cells[2] ?? '',
      status: status ?? 'MISSING',
      body,
      statusCells: cells.filter((c) => (STATUSES as readonly string[]).includes(c)).length,
    });
  }
  return out;
}

const ROWS = rows();

describe('the WBS is a document something checks', () => {
  it('parses as a table of work rows, so the checks below are not vacuous', () => {
    // WITHOUT THIS the rest of the file passes over an empty list — a green
    // suite that checked nothing, which is the failure mode these tests exist
    // to catch in the first place.
    expect(ROWS.length).toBeGreaterThan(80);
    expect(ROWS.filter((r) => r.status === '**DONE**').length).toBeGreaterThan(0);
    expect(ROWS.filter((r) => r.status === '**PART**').length).toBeGreaterThan(0);
  });

  it('captures every work row, pinned by count', () => {
    // PINNED, because the parser has silently under-counted twice: first by
    // skipping statusless rows, then by an ID grammar that did not match the
    // composite row `5.9 / 7.1`. A checker that decides which rows to look at
    // can decline to look at the broken ones, and nothing said so.
    expect(ROWS.length).toBe(97);
    expect(ROWS.map((r) => r.id)).toContain('5.9 / 7.1');
  });


  it('gives every work row exactly one status', () => {
    // REWRITTEN — the first version could not fail. It tested `body`, which is
    // the LONGEST cell and therefore never the 8-character status cell, with
    // `startsWith` against three mutually exclusive tokens: unsatisfiable twice
    // over. A tautology inside the one file whose purpose is to stop rules
    // nobody evaluates is the joke telling itself, and a reviewer found it.
    // The property belongs on the CELL LIST, where two status cells is a thing
    // that can actually happen.
    const ambiguous = ROWS.filter((r) => r.statusCells !== 1);

    expect(ambiguous.map((r) => `${r.id} has ${String(r.statusCells)} status cells`)).toEqual([]);
  });
});

describe('an unfinished row says what is unfinished', () => {
  it('states a gap on every PART and TODO row', () => {
    // Row 3.8's exact failure. The vocabulary is wide on purpose — see the
    // header. What is being caught is a row that says nothing at all about
    // why it is not done.
    const GAP =
      /\bopen\b|\bblocked\b|\bpending\b|\bremain|out of (commerce'?s )?scope|BOUNDARY|stays \*\*PART\*\*|\bneeds\b|\bawait/i;
    const silent = ROWS.filter((r) => r.status !== '**DONE**' && !GAP.test(r.body));

    expect(
      silent.map((r) => `${r.id} (${r.title}) is ${r.status} and names no outstanding work`),
    ).toEqual([]);
  });
});

describe('a row’s evidence can be followed', () => {
  it('cites no repo path that does not exist', () => {
    // Only REPO-ROOTED paths are checked. Rows also cite package-relative
    // paths (`conformance/runner.ts`), and resolving those would need a guess
    // about which package — a guess is how a check starts reporting failures
    // that are really its own. Ambiguous citations get disambiguated in the
    // document instead: `docs/conformance.md` existed under TWO packages and
    // now names the one it means.
    const source = fs.readFileSync(WBS, 'utf8');
    const cited = new Set(
      [...source.matchAll(/`((?:packages|appview|apps|docs|cli|scripts|msgbox|services)\/[A-Za-z0-9_./-]+\.[a-z]{2,4})`/g)].map(
        (m) => m[1] as string,
      ),
    );

    expect(cited.size).toBeGreaterThan(0);
    const missing = [...cited].filter((p) => !fs.existsSync(path.join(REPO_ROOT, p))).sort();

    expect(missing).toEqual([]);
  });
});
