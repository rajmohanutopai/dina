import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const FORBIDDEN_DEEP_IMPORT = /from\s+['"]@dina\/(?:core|brain)\/src\//;
const RETIRED_RUNTIME_TERMS = /\b(?:BrainCoreClient|buildBrainCoreClient|BrainCoreClientResult)\b/;

describe('brain-server package boundaries', () => {
  it('keeps production code on public @dina/core and @dina/brain entry points', async () => {
    const files = await listTsFiles(join(__dirname, '..', 'src'));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (FORBIDDEN_DEEP_IMPORT.test(source)) {
        offenders.push(relative(join(__dirname, '..'), file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not preserve retired BrainCoreClient-era runtime naming', async () => {
    const files = await listTsFiles(join(__dirname, '..', 'src'));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (RETIRED_RUNTIME_TERMS.test(source)) {
        offenders.push(relative(join(__dirname, '..'), file));
      }
    }

    expect(offenders).toEqual([]);
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
