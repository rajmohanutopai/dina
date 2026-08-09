/**
 * Both boots compose the commerce runtime (§23, WS-3.6).
 *
 * A STATIC check on the two composition roots, and it exists because the
 * failure it catches is invisible at runtime. Teardown on mobile has always
 * called `installCommerceRuntime(null)`, so the code READ as though a runtime
 * existed; nothing created one. Every commerce path then found null and failed
 * closed — which is exactly what a correctly-refusing node looks like, so no
 * test and no user could tell the difference.
 *
 * Comparing the two roots is the only version of this check that cannot itself
 * drift: a behavioural test would need a booted app, and an assertion about
 * one root alone would pass while the other quietly dropped the wiring.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const ROOTS = {
  mobile: path.join(REPO, 'apps', 'mobile', 'src', 'storage', 'init.ts'),
  server: path.join(REPO, 'apps', 'home-node-lite', 'core-server', 'src', 'storage', 'init.ts'),
};

/** Strip comments, so prose ABOUT the wiring is never mistaken for it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('commerce composition roots', () => {
  it.each(Object.entries(ROOTS))('%s creates a commerce runtime', (_name, file) => {
    expect(code(readFileSync(file, 'utf8'))).toContain('createCommerceRuntime(');
  });

  it('mobile also tears the runtime down, because it switches identity in one process', () => {
    // The asymmetry is real, not an omission. A phone signs out and signs in
    // again inside the SAME JS process, so a surviving runtime would hold the
    // previous identity's adapter; the server boots one identity per process
    // and has no teardown path at all. A first version of this test demanded
    // the teardown on both roots and failed on the server for a difference
    // that is correct.
    expect(code(readFileSync(ROOTS.mobile, 'utf8'))).toContain('installCommerceRuntime(null)');
  });

  it.each(Object.entries(ROOTS))(
    '%s reads identity and epoch through fail-closed thunks',
    (_name, file) => {
      const body = code(readFileSync(file, 'utf8'));
      // §16.2: a node that signed under a guessed identity or a missing epoch
      // would produce commitments it cannot stand behind. Both roots therefore
      // THROW rather than defaulting — a `?? ''` here would be the whole fence.
      expect(body).toMatch(/supplierDid:\s*\(\)\s*=>/);
      expect(body).toMatch(/currentEpoch:\s*\(\)\s*=>/);
      expect(body).toContain('signing is fail-closed');
    },
  );
});
