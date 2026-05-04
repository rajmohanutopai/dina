import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const FORBIDDEN_DEEP_IMPORT = /from\s+['"]@dina\/(?:core|brain)\/src\//;

describe('@dina/home-node package boundaries', () => {
  it('keeps shared runtime code on public @dina/core and @dina/brain entry points', async () => {
    const root = join(__dirname, '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      join(root, 'ask-runtime.ts'),
      join(root, 'service-runtime.ts'),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (FORBIDDEN_DEEP_IMPORT.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('declares shared runtime subpaths in package exports', async () => {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf8'));

    expect(pkg.exports).toEqual({
      '.': {
        types: './src/index.ts',
        default: './src/index.ts',
      },
      './ask-runtime': {
        types: './ask-runtime.ts',
        default: './ask-runtime.ts',
      },
      './service-runtime': {
        types: './service-runtime.ts',
        default: './service-runtime.ts',
      },
    });
  });
});

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listTsFiles(path);
      if (entry.isFile() && path.endsWith('.ts')) return [path];
      return [];
    }),
  );
  return nested.flat();
}
