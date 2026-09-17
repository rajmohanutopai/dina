/**
 * Composition properties of the shared workflow plane — asserted over the
 * source, because a behavioural test drives one wiring and cannot notice
 * that a second one was assembled differently (the same reasoning as the
 * lite server's `workflow_service_composition.test.ts`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const PLANE = path.join(__dirname, '..', 'src', 'workflow_plane.ts');

describe('wireWorkflowPlane composition', () => {
  it('runs the TaskExpirySweeper through the WorkflowService so a lapsed approval reaches the decision handler', () => {
    // GROUP_COORDINATION §6: a disclosure review nobody answered must still
    // let the availability leave without the fact. Only the service's
    // `expireTasks` tells the handler about a lapse; the bare repository
    // flips rows in silence.
    const source = readFileSync(PLANE, 'utf8');
    const sweepers = [...source.matchAll(/new TaskExpirySweeper\(\{/g)];
    expect(sweepers.length).toBeGreaterThan(0);
    for (const match of sweepers) {
      const body = balancedArgument(source, (match.index ?? 0) + match[0].length - 1) ?? '';
      const repository = /(^|[\s{,])repository\s*:\s*([A-Za-z_$][\w$]*)/.exec(body);
      expect(repository?.[2]).toBe('workflowService');
    }
  });
});

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
