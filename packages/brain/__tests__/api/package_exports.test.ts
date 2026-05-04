import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXPECTED_EXPORTS: Record<string, string> = {
  '.': './src/index.ts',
  './chat': './chat.ts',
  './enrichment': './enrichment.ts',
  './llm': './llm.ts',
  './node-trace-storage': './node-trace-storage.ts',
  './notifications': './notifications.ts',
  './runtime': './runtime.ts',
};

describe('@dina/brain package exports', () => {
  it('declares the public Brain entry points explicitly', async () => {
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
