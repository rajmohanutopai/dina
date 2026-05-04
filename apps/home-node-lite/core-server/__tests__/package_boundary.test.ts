import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const BRAIN_SUBTREE_IMPORT = /from\s+['"](?:\.{1,2}\/)+brain(?:\/|['"])/;
const BRAIN_DEEP_IMPORT = /from\s+['"]@dina\/brain\/src\//;

describe('core-server package boundaries', () => {
  it('does not keep a parallel Brain implementation under core-server', async () => {
    const root = join(__dirname, '..');
    expect(await pathExists(join(root, 'src', 'brain'))).toBe(false);
  });

  it('keeps production Core server code independent of Brain internals', async () => {
    const root = join(__dirname, '..');
    const sourceRoot = join(root, 'src');
    const files = await listTsFiles(sourceRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (BRAIN_SUBTREE_IMPORT.test(source) || BRAIN_DEEP_IMPORT.test(source)) {
        offenders.push(relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not keep tests for the retired core-server Brain subtree', async () => {
    const root = join(__dirname, '..');
    const files = await listTsFiles(join(root, '__tests__'));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/from\s+['"]\.\.\/src\/brain(?:\/|['"])/.test(source)) {
        offenders.push(relative(root, file));
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
