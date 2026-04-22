/**
 * Task 3.50 — treeshaking verification for `@dina/adapters-node`.
 *
 * The meta package re-exports every Node-target capability under a
 * capability-named alias. Consumers who only import one capability
 * (`FileSystem`) must NOT pull every other capability's transitive
 * dependency graph into their bundle — `argon2`, `libsodium-wrappers`,
 * `ws`, etc. should stay out when they're not reached.
 *
 * Strategy:
 *   1. Build a synthetic consumer that imports exactly one alias.
 *   2. Run esbuild in production mode (minify + treeshake) with the
 *      metafile enabled.
 *   3. Inspect the metafile's input list — assert the forbidden
 *      capability packages aren't in there.
 *
 * We assert at the *package* level (e.g. `@dina/crypto-node` isn't
 * reached when only `FileSystem` is imported), not at every transitive
 * module, because the package boundaries are what external consumers
 * care about.
 *
 * Node's built-ins (`node:*`) and a handful of tiny shared utilities
 * may appear regardless — that's fine. The check is that capability
 * *packages* that a consumer didn't ask for stay out.
 */

import * as path from 'node:path';
import { build } from 'esbuild';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

type BuildResult = {
  /** Paths that contributed >0 bytes to the final bundle (post-treeshake). */
  bundled: string[];
  /** Total bundle size in bytes. */
  bundleSize: number;
};

/**
 * Bundle a synthetic consumer stub that imports the given symbols from
 * `@dina/adapters-node`. Returns the post-treeshake bundled-input list
 * (files with bytesInOutput > 0) and the total bundle size.
 *
 * Relying on bytesInOutput (not metafile.inputs) matters: esbuild
 * *scans* many more modules than it *bundles*. Scanning is how it
 * walks the ESM re-export graph to know what's used; bundling is what
 * actually lands in the output. Treeshaking correctness is the latter.
 */
async function bundleConsumer(importLine: string): Promise<BuildResult> {
  const stub = `
    ${importLine}
    // Force the bundler to retain the import — otherwise it'd elide
    // the whole stub as dead code. This mirrors what a real consumer
    // would do (instantiate the class, call a method).
    globalThis.__keepAlive = __sink;
  `;
  const result = await build({
    stdin: {
      contents: stub,
      loader: 'ts',
      resolveDir: WORKSPACE_ROOT,
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // Match what a production consumer would do: minify + treeshake.
    // Without minify, esbuild emits debug wrappers that make bytesInOutput
    // include declarations it would otherwise elide.
    minify: true,
    treeShaking: true,
    metafile: true,
    write: false,
    logLevel: 'silent',
    // Native / peer-optional deps that the adapters don't hard-require.
    external: ['argon2', 'libsodium-wrappers', 'ws', 'keytar'],
  });

  if (!result.metafile) throw new Error('esbuild: no metafile produced');

  const output = Object.values(result.metafile.outputs)[0];
  if (!output) throw new Error('esbuild: no output in metafile');

  const bundled = Object.entries(output.inputs)
    .filter(([, info]) => info.bytesInOutput > 0)
    .map(([p]) => (path.isAbsolute(p) ? path.relative(WORKSPACE_ROOT, p) : p));

  return { bundled, bundleSize: output.bytes };
}

function reachesPackage(bundled: string[], pkgName: string): boolean {
  // Source-linked workspace packages land as `packages/<short>/src/...`
  // when resolved from the workspace root, or `../<short>/src/...` when
  // resolved from a sibling package's cwd. External npm packages land as
  // `node_modules/<name>/...`. Match loosely on the segment boundary
  // since both forms end in `<short>/src/`.
  const isWorkspacePkg = pkgName.startsWith('@dina/');
  if (isWorkspacePkg) {
    const shortName = pkgName.slice('@dina/'.length);
    return bundled.some(
      (p) =>
        p.includes(`/${shortName}/src/`) ||
        p.startsWith(`${shortName}/src/`) ||
        p.includes(`node_modules/${pkgName}/`),
    );
  }
  return bundled.some((p) => p.includes(`node_modules/${pkgName}/`));
}

describe('adapters-node — treeshaking', () => {
  it('importing only FileSystem leaves crypto/keystore/net out of the bundle', async () => {
    const { bundled } = await bundleConsumer(
      `import { FileSystem } from '@dina/adapters-node';\n` +
        `const __sink = new FileSystem();`,
    );
    expect(reachesPackage(bundled, '@dina/fs-node')).toBe(true);
    expect(reachesPackage(bundled, '@dina/crypto-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/keystore-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/net-node')).toBe(false);
    // @noble/* are crypto-node / net-node transitives — must not appear.
    expect(reachesPackage(bundled, '@noble/curves')).toBe(false);
    expect(reachesPackage(bundled, '@noble/ed25519')).toBe(false);
    expect(reachesPackage(bundled, '@noble/hashes')).toBe(false);
  });

  it('importing only Crypto leaves fs/keystore/net out of the bundle', async () => {
    const { bundled } = await bundleConsumer(
      `import { Crypto } from '@dina/adapters-node';\n` +
        `const __sink = new Crypto();`,
    );
    expect(reachesPackage(bundled, '@dina/crypto-node')).toBe(true);
    expect(reachesPackage(bundled, '@dina/fs-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/keystore-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/net-node')).toBe(false);
  });

  it('importing only HttpClient leaves fs/keystore/crypto out of the bundle', async () => {
    const { bundled } = await bundleConsumer(
      `import { HttpClient } from '@dina/adapters-node';\n` +
        `const __sink = new HttpClient();`,
    );
    expect(reachesPackage(bundled, '@dina/net-node')).toBe(true);
    expect(reachesPackage(bundled, '@dina/fs-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/keystore-node')).toBe(false);
    // Crypto-node contains @noble/curves + ed25519; HttpClient alone
    // must not drag those in.
    expect(reachesPackage(bundled, '@dina/crypto-node')).toBe(false);
    expect(reachesPackage(bundled, '@noble/ed25519')).toBe(false);
    expect(reachesPackage(bundled, '@noble/curves')).toBe(false);
  });

  it('importing only FileKeystore leaves fs/crypto/net out of the bundle', async () => {
    const { bundled } = await bundleConsumer(
      `import { FileKeystore } from '@dina/adapters-node';\n` +
        `const __sink = new FileKeystore({ rootDir: '/tmp/x' });`,
    );
    expect(reachesPackage(bundled, '@dina/keystore-node')).toBe(true);
    expect(reachesPackage(bundled, '@dina/fs-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/crypto-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/net-node')).toBe(false);
  });

  it('importing FileSystem + HttpClient bundles both but not crypto/keystore', async () => {
    const { bundled } = await bundleConsumer(
      `import { FileSystem, HttpClient } from '@dina/adapters-node';\n` +
        `const __sink = [new FileSystem(), new HttpClient()];`,
    );
    expect(reachesPackage(bundled, '@dina/fs-node')).toBe(true);
    expect(reachesPackage(bundled, '@dina/net-node')).toBe(true);
    expect(reachesPackage(bundled, '@dina/crypto-node')).toBe(false);
    expect(reachesPackage(bundled, '@dina/keystore-node')).toBe(false);
  });

  it('FileSystem-only bundle stays small (< 5 KiB)', async () => {
    // Sanity cap: if someone accidentally reverts the sideEffects: false
    // declarations, the bundle will balloon past this limit because the
    // whole capability stack lands.
    const { bundleSize } = await bundleConsumer(
      `import { FileSystem } from '@dina/adapters-node';\n` +
        `const __sink = new FileSystem();`,
    );
    expect(bundleSize).toBeLessThan(5 * 1024);
  });
});
