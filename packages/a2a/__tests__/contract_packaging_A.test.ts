/**
 * @dina/a2a reaches every build that uses it (notes M2 "two packaging
 * faults", M5 step 3 "@dina/a2a becomes an AppView dependency"; plan §3.15).
 *
 * The files that decide this are read as text: the lockfile, the lite
 * Dockerfiles, AppView's Dockerfile, its CI workflow and its scripts. `npm ci`
 * runs for real, as a dry run with no network, on a copy of the tree's
 * manifests and lockfile. A real image build needs Docker and a network, so
 * it is still owed; the Dockerfile checks below stand in for it.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: Record<string, Record<string, Record<string, string>>>;
}

/** Every workspace directory the root manifest names, by package name. */
function workspaces(): Map<string, string> {
  const globs = readJson<{ workspaces: string[] }>('package.json').workspaces;
  const out = new Map<string, string>();
  for (const glob of globs) {
    const dirs = glob.endsWith('/*')
      ? readdirSync(join(ROOT, glob.slice(0, -2)), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${glob.slice(0, -2)}/${d.name}`)
      : [glob];
    for (const dir of dirs) {
      if (!existsSync(join(ROOT, dir, 'package.json'))) continue;
      out.set(readJson<Manifest>(`${dir}/package.json`).name, dir);
    }
  }
  return out;
}

const WORKSPACES = workspaces();
const dinaDeps = (m: Manifest, withDev: boolean): string[] =>
  Object.keys({ ...m.dependencies, ...(withDev ? m.devDependencies : {}) }).filter((n) => n.startsWith('@dina/'));

/** The workspace packages an app needs: its own @dina deps (dev too, npm ci installs them) and theirs, transitively. */
function closure(appDir: string): string[] {
  const seen = new Set<string>();
  const queue = dinaDeps(readJson<Manifest>(`${appDir}/package.json`), true);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = WORKSPACES.get(name);
    if (dir === undefined) throw new Error(`${name} is not a workspace`);
    queue.push(...dinaDeps(readJson<Manifest>(`${dir}/package.json`), false));
  }
  return [...seen].sort();
}

/** The lines of one Dockerfile stage, from its FROM to the next. */
function stage(text: string, name: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'i').test(l));
  if (start === -1) throw new Error(`no stage ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l));
  return lines.slice(start, end === -1 ? undefined : end);
}

const indexOf = (lines: string[], pattern: RegExp): number => lines.findIndex((l) => pattern.test(l));
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the lockfile knows @dina/a2a (notes M2: npm ci refused a tree without it)', () => {
  const lock = readJson<{ packages: Record<string, { name?: string; resolved?: string; link?: boolean; dependencies?: Record<string, string> }> }>(
    'package-lock.json',
  );

  // Plan X-3
  it('lists packages/a2a as a workspace and links node_modules/@dina/a2a to it', () => {
    expect(WORKSPACES.get('@dina/a2a')).toBe('packages/a2a');
    expect(lock.packages['packages/a2a']?.name).toBe('@dina/a2a');
    expect(lock.packages['node_modules/@dina/a2a']).toMatchObject({ resolved: 'packages/a2a', link: true });
  });

  // Plan X-3
  it('records @dina/a2a for every workspace whose manifest depends on it', () => {
    const dependents = [...WORKSPACES].filter(([, dir]) => {
      const m = readJson<Manifest>(`${dir}/package.json`);
      return m.dependencies?.['@dina/a2a'] !== undefined;
    });
    expect(dependents.map(([name]) => name)).toEqual(
      expect.arrayContaining(['@dina/core', '@dina/brain', '@dina/home-node', '@dina/appview', '@dina/home-node-lite-a2a-gateway']),
    );
    for (const [name, dir] of dependents) {
      expect([name, lock.packages[dir]?.dependencies?.['@dina/a2a']]).toEqual([name, expect.any(String)]);
    }
  });
});

describe('npm ci accepts the tree as committed (notes M2: npm ci refused a tree without @dina/a2a)', () => {
  let tmp = '';
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dina-npm-ci-'));
  });
  afterAll(() => {
    if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  });

  /** A copy of the root manifest, the lockfile and every workspace manifest: all that `npm ci` checks against each other. */
  const manifestTree = (dir: string, lockfile: string): void => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    writeFileSync(join(dir, 'package-lock.json'), lockfile);
    for (const ws of WORKSPACES.values()) {
      mkdirSync(join(dir, ws), { recursive: true });
      copyFileSync(join(ROOT, ws, 'package.json'), join(dir, ws, 'package.json'));
    }
  };

  /** `npm ci` as a dry run: no network, no scripts, its own cache and logs, none of the npm settings of the run that started jest. */
  const npmCi = (dir: string): string => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_')));
    const args = ['ci', '--dry-run', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'];
    args.push('--cache', join(dir, '.npm-cache'), '--logs-dir', join(dir, '.npm-logs'));
    return execFileSync('npm', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
  };

  /** What a failed `npm ci` printed, or '' when it passed. */
  const refusal = (dir: string): string => {
    try {
      npmCi(dir);
      return '';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  };

  // Plan X-3
  it(
    'installs from the committed lockfile and manifests',
    () => {
      const dir = join(tmp, 'as-committed');
      manifestTree(dir, read('package-lock.json'));
      expect(refusal(dir)).toBe('');
    },
    120_000,
  );

  // Plan X-3
  it(
    'refuses the same tree once the lockfile drops @dina/a2a, the M2 fault',
    () => {
      const lock = readJson<{ packages: Record<string, unknown> }>('package-lock.json');
      expect(lock.packages['packages/a2a']).toBeDefined();
      delete lock.packages['packages/a2a'];
      delete lock.packages['node_modules/@dina/a2a'];
      const dir = join(tmp, 'without-a2a');
      manifestTree(dir, JSON.stringify(lock, null, 2));
      expect(refusal(dir)).toMatch(/Missing: @dina\/a2a@\S+ from lock file/);
    },
    120_000,
  );
});

/**
 * What a lite builder stage gets wrong for `appDir`, by name; [] when nothing.
 * Every manifest the app's graph needs, the app's own among them, is copied
 * before `npm ci`; the sources after it.
 */
function liteBuilderProblems(lines: string[], appDir: string): string[] {
  const install = indexOf(lines, /^RUN npm ci\b/);
  if (install <= 0) return ['npm ci'];
  const before = (dir: string): boolean => {
    const at = indexOf(lines, new RegExp(`^COPY .*\\b${escape(dir)}/package\\.json\\b`));
    return at >= 0 && at < install;
  };
  const after = (pattern: RegExp): boolean => indexOf(lines, pattern) > install;
  return [
    ...closure(appDir)
      .filter((name) => !before(WORKSPACES.get(name) as string))
      .map((name) => `${name} manifest`),
    ...(before(appDir) ? [] : [`${appDir} manifest`]),
    ...(after(/^COPY packages\/ \.\/packages\/$/) ? [] : ['packages sources']),
    ...(after(new RegExp(`^COPY ${escape(appDir)}/ \\./${escape(appDir)}/$`)) ? [] : [`${appDir} sources`]),
  ];
}

describe('every lite image carries @dina/a2a and the rest of its workspace graph (notes M2)', () => {
  // Plan X-3
  it.each([
    ['apps/home-node-lite/docker/Dockerfile.core', 'apps/home-node-lite/core-server'],
    ['apps/home-node-lite/docker/Dockerfile.brain', 'apps/home-node-lite/brain-server'],
    ['apps/home-node-lite/docker/Dockerfile.a2a-gateway', 'apps/home-node-lite/a2a-gateway'],
  ])('%s copies the manifest of every package %s needs before npm ci, then their sources', (dockerfile, appDir) => {
    expect(closure(appDir)).toContain('@dina/a2a');
    expect(liteBuilderProblems(stage(read(dockerfile), 'builder'), appDir)).toEqual([]);
  });

  // Plan X-3
  it('names the manifest a builder leaves out, or copies only after npm ci', () => {
    const appDir = 'apps/home-node-lite/a2a-gateway';
    const lines = stage(read('apps/home-node-lite/docker/Dockerfile.a2a-gateway'), 'builder');
    const without = (pattern: RegExp): string[] => {
      const kept = lines.filter((l) => !pattern.test(l));
      expect(kept).toHaveLength(lines.length - 1);
      return kept;
    };
    const moved = (pattern: RegExp): string[] => [...without(pattern), ...lines.filter((l) => pattern.test(l))];
    const appManifest = /^COPY apps\/home-node-lite\/a2a-gateway\/package\.json /;
    const a2aManifest = /^COPY packages\/a2a\/package\.json /;
    expect(liteBuilderProblems(without(appManifest), appDir)).toEqual([`${appDir} manifest`]);
    expect(liteBuilderProblems(moved(appManifest), appDir)).toEqual([`${appDir} manifest`]);
    expect(liteBuilderProblems(without(a2aManifest), appDir)).toEqual(['@dina/a2a manifest']);
    expect(liteBuilderProblems(without(/^COPY packages\/ \.\/packages\/$/), appDir)).toEqual(['packages sources']);
  });
});

/** What AppView's builder gets wrong about @dina/a2a, by name; [] when nothing. Its sources, then its build, then AppView's compile. */
function appviewBuilderProblems(builder: string[]): string[] {
  const src = indexOf(builder, /^COPY packages\/a2a\/ packages\/a2a\/$/);
  const build = indexOf(builder, /^RUN npm run build --workspace @dina\/a2a$/);
  const compile = indexOf(builder, /^RUN npx --no-install tsc\b/);
  return [
    ...(src >= 0 ? [] : ['a2a sources']),
    ...(build > src && src >= 0 ? [] : ['a2a build after its sources']),
    ...(compile > build && build >= 0 ? [] : ['AppView compile after the a2a build']),
  ];
}

describe('AppView builds and tests the @dina/a2a it ships (notes M5 step 3)', () => {
  const dockerfile = read('appview/Dockerfile');
  const appviewDeps = closure('appview');

  // Plan X-3
  it.each(['builder', 'migrator', 'runner'])('the %s stage installs every workspace package AppView needs, @dina/a2a among them', (name) => {
    expect(appviewDeps).toContain('@dina/a2a');
    const lines = stage(dockerfile, name);
    const install = indexOf(lines, /^RUN npm ci\b/);
    expect(install).toBeGreaterThan(0);
    for (const dep of [...appviewDeps, '@dina/appview']) {
      const dir = WORKSPACES.get(dep) as string;
      expect([dep, (lines[install] ?? '').includes(`--workspace ${dep}`)]).toEqual([dep, true]);
      const at = indexOf(lines, new RegExp(`^COPY ${escape(dir)}/package\\.json ${escape(dir)}/$`));
      expect([dep, at >= 0 && at < install]).toEqual([dep, true]);
    }
  });

  // Plan X-3
  it('builds @dina/a2a in the builder before AppView compiles, and ships only that build', () => {
    const builder = stage(dockerfile, 'builder');
    expect(appviewBuilderProblems(builder)).toEqual([]);
    // A builder that never copies the a2a sources fails the check.
    expect(appviewBuilderProblems(builder.filter((l) => !/^COPY packages\/a2a\/ packages\/a2a\/$/.test(l)))).toContain('a2a sources');
    const runner = stage(dockerfile, 'runner');
    expect(indexOf(runner, /^COPY --from=builder \/repo\/packages\/a2a\/dist packages\/a2a\/dist\/$/)).toBeGreaterThan(0);
    expect(indexOf(runner, /^COPY packages\/a2a\/ /)).toBe(-1);
  });

  // Plan X-3
  it('runs its CI on any change under packages/a2a', () => {
    const workflow = read('.github/workflows/appview-test.yml');
    const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\njobs:'));
    const push = triggers.slice(triggers.indexOf('push:'), triggers.indexOf('pull_request:'));
    const pr = triggers.slice(triggers.indexOf('pull_request:'));
    for (const block of [push, pr]) expect(block).toContain('- "packages/a2a/**"');
  });

  // Plan X-3
  it('rebuilds @dina/a2a from source before every test and typecheck run, so a stale dist cannot pass', () => {
    const appview = readJson<Manifest>('appview/package.json');
    const a2a = readJson<Manifest>('packages/a2a/package.json');
    const scripts = appview.scripts ?? {};
    expect(scripts['build:protocol']).toContain('--prefix ../packages/a2a run build');
    for (const name of ['test:unit', 'test:integration', 'test:all', 'typecheck', 'build']) {
      expect([name, (scripts[name] ?? '').startsWith('npm run build:protocol && ')]).toEqual([name, true]);
    }
    // The build starts from an empty dist, so a deleted source file leaves nothing behind.
    expect(a2a.scripts?.build).toMatch(/^rm -rf dist && tsc\b/);
    // AppView's tests load the build, as its runtime does.
    expect(a2a.exports?.['.']?.compiled?.default).toBe('./dist/index.js');
    expect(read('appview/vitest.config.ts')).toMatch(/conditions:\s*\['compiled'\]/);
    // CI checks out no dist to be stale: git never tracks one.
    expect(read('.gitignore').split('\n').map((l) => l.trim())).toContain('dist/');
    // The CI steps run those scripts, never vitest on its own.
    const workflow = read('.github/workflows/appview-test.yml');
    expect(workflow).toContain('npm run test:unit --workspace @dina/appview');
    expect(workflow).toContain('npm run test:integration --workspace @dina/appview');
  });
});
