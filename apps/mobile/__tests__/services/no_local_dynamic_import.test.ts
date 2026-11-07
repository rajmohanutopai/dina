/**
 * A dynamic `import('./…')` of the app's own code makes Metro split a chunk
 * and fetch it by URL. In a `--no-dev` bundle that fetch fails ("Unable to
 * determine the production URL where additional JavaScript chunks are
 * hosted"), and the caller gets an error instead of the module. It hid every
 * model call on the simulator: the names list behind PII scrubbing was
 * loaded this way, so Brain refused to send anything (found 2026-11-02).
 *
 * Lazy loads of the app's own modules use `require()` inside the function.
 * Package imports (`import('expo-clipboard')`), type positions
 * (`import('./x').Type`) and web-only `.web.ts` files (the browser can fetch
 * chunks) are not covered here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOTS = ['src', 'app'].map((d) => path.join(__dirname, '..', '..', d));
const LOCAL_DYNAMIC_IMPORT = /\bimport\(\s*['"]\.{1,2}\//;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.web\.tsx?$/.test(e.name) ? [p] : [];
  });
}

it("no app code loads the app's own modules with a dynamic import()", () => {
  const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        LOCAL_DYNAMIC_IMPORT.test(line) &&
        !/^\s*(\/\/|\*)/.test(line) &&
        !/typeof import\(/.test(line) &&
        !/import\([^)]*\)\.[A-Z]/.test(line)
          ? [`${path.relative(path.join(__dirname, '..', '..'), file)}:${i + 1}`]
          : [],
      ),
  );
  expect(offenders).toEqual([]);
});
