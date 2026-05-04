import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXPECTED_EXPORTS: Record<string, string> = {
  '.': './src/index.ts',
  './audit': './audit.ts',
  './d2d': './d2d.ts',
  './devices': './devices.ts',
  './kv': './kv.ts',
  './reminders': './reminders.ts',
  './runtime': './runtime.ts',
  './storage': './storage.ts',
};

describe('@dina/core package exports', () => {
  it('declares the public Core entry points explicitly', async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    );

    expect(Object.keys(pkg.exports).sort()).toEqual(Object.keys(EXPECTED_EXPORTS).sort());
    for (const [subpath, sourcePath] of Object.entries(EXPECTED_EXPORTS)) {
      expect(pkg.exports[subpath]).toEqual({
        types: sourcePath,
        default: sourcePath,
      });
    }
    expect(Object.keys(pkg.exports)).not.toContain('./src/*');
  });
});
