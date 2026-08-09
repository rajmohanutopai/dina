/**
 * Every WorkflowService this server builds must broker host operations
 * (§3.4).
 *
 * WHY A SOURCE-LEVEL TEST AND NOT A BEHAVIOURAL ONE. The defect this
 * guards is a COMPOSITION defect, and behavioural tests kept missing it:
 * boot constructs a degraded-mode `WorkflowService` before identity is
 * available and `wireWorkflowPlane` replaces it later with a fully-wired
 * one. Every test that exercised the wired service passed, because the
 * wired service is fine. The degraded one — live for the whole window
 * before identity resolves — had no `pluginCompletionHandler`, so a
 * completion carrying a host-operation proposal took the ordinary path:
 * recorded as a successful result, no broker, no permit, no effect, and
 * nothing in the record to distinguish it from a genuine answer.
 *
 * A test that drives one instance cannot catch an unwired second one. So
 * this asserts the property over the CONSTRUCTIONS themselves, and it
 * fails the moment someone adds a third.
 *
 * This is the same shape as the commerce aggregate-boundary test, and for
 * the same reason: some invariants are about the code's structure rather
 * than any one run of it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const BOOT = path.join(__dirname, '..', 'src', 'boot.ts');

describe('workflow service composition', () => {
  it('gives every constructed WorkflowService a plugin completion handler', () => {
    const source = readFileSync(BOOT, 'utf8');
    const constructions = [...source.matchAll(/new WorkflowService\(\{/g)];

    // If this is zero the test has stopped testing anything — a rename or a
    // move would otherwise leave it passing over an empty set.
    expect(constructions.length).toBeGreaterThan(0);

    for (const match of constructions) {
      const start = match.index ?? 0;
      const body = balancedArgument(source, start + match[0].length - 1);
      expect(body).not.toBeNull();
      // Matched as a PROPERTY KEY, not a substring. `toContain` passed
      // against a field renamed to `MUTATED_pluginCompletionHandlerXX`,
      // which is the assertion being weaker than the claim it makes.
      // eslint-disable-next-line jest/no-conditional-in-test -- guarded above
      expect(body ?? '').toMatch(/(^|[\s{,])pluginCompletionHandler\s*:/);
    }
  });
});

/**
 * The text of a brace-balanced block starting at `open`.
 *
 * A regex cannot do this: the options object contains nested objects and
 * arrow functions, so "up to the next `}`" would stop at the first inner
 * one and the assertion would read a fragment.
 */
function balancedArgument(source: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}
