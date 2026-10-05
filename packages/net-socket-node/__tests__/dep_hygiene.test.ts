/**
 * Dep-hygiene gate — @dina/net-socket-node is the Node half of the policy
 * socket (UCP plan §3.3): it depends on @dina/net-policy only, plus Node
 * builtins, so AppView and the server Core can both take it without pulling in
 * the rest of Dina.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

describe('dep hygiene', () => {
  const files = readdirSync(join(ROOT, 'src')).filter((n) => n.endsWith('.ts'));

  it('src/ imports relative paths, node: builtins and @dina/net-policy only', () => {
    const violations: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(ROOT, 'src', name), 'utf8');
      for (const m of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        if (!spec.startsWith('./') && !spec.startsWith('node:') && spec !== '@dina/net-policy') {
          violations.push(`${name}: "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json depends at runtime on @dina/net-policy only', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@dina/net-policy']);
  });
});
