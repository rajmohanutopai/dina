/**
 * REQ-01 + REQ-04: a sweep nobody schedules was the bug. Both composition roots
 * must start and stop the staging sweeper. A behavioural test drives one wiring
 * and cannot see that the other forgot, so this reads both.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const ROOTS = [
  path.join(REPO, 'apps', 'home-node-lite', 'core-server', 'src', 'boot.ts'),
  path.join(REPO, 'apps', 'mobile', 'src', 'services', 'bootstrap.ts'),
];

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('staging sweep wiring', () => {
  it.each(ROOTS)('%s builds, starts and stops the StagingSweeper', (root) => {
    const body = code(fs.readFileSync(root, 'utf8'));
    expect(body).toMatch(/new StagingSweeper\(/);
    expect(body).toMatch(/[sS]tagingSweeper\??\.start\(\)/);
    expect(body).toMatch(/[sS]tagingSweeper\??\.stop\(\)/);
  });
});
