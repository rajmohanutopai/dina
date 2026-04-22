/**
 * npm-publish readiness gate (task 10.18 prep).
 *
 * `@dina/protocol` is the cross-language compatibility contract —
 * any Python / Go / Rust / Swift port of Dina links against this
 * package's wire-format fixtures + canonical types. That makes
 * "publishable to npm" a load-bearing property.
 *
 * Task 10.18 itself is user-action (publish requires npm
 * credentials — the maintainer runs `npm publish` from a clean
 * tree). The *prep* — the package shape that makes the publish a
 * one-liner — lives here and is regression-gated by this test.
 *
 * The test pins four invariants:
 *
 *   1. `files` whitelist exists — limits published content to
 *      `dist/ + README.md + docs/`, keeping tests + conformance +
 *      fixtures + node_modules out of the tarball.
 *   2. `publishConfig` overrides `main/types/exports` to point at
 *      `dist/` — the in-repo package.json still points at `src/`
 *      so workspace consumers (ts-jest, tsc) see the TypeScript
 *      source directly, but `npm publish` rewrites these to the
 *      built artefacts. This is the two-file-no-dist-commit pattern.
 *   3. `build` script exists + follows the convention
 *      `rm -rf dist && tsc --project tsconfig.build.json`.
 *   4. `prepublishOnly` runs `build` AND `test` — catches
 *      accidental publish of an un-built or test-failing tree.
 *
 * Does NOT run the build itself (slow) — test 10.18 is triggered
 * by the maintainer running `npm run build` manually, whose output
 * surfaces tsc errors. This test is the shape-of-the-package gate,
 * not the artefact-correctness gate.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 10 task 10.18.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  main?: string;
  types?: string;
  exports?: unknown;
  files?: string[];
  scripts?: Record<string, string>;
  publishConfig?: {
    main?: string;
    types?: string;
    exports?: Record<string, unknown>;
  };
};

describe('@dina/protocol npm-publish readiness (task 10.18 prep)', () => {
  describe('in-repo package shape (dev-mode consumption)', () => {
    it('main + types point at source so the workspace consumes TypeScript directly', () => {
      // ts-jest, tsc, and other workspace tooling load src/index.ts.
      // If these got flipped to dist/ without a build, workspace tests
      // would fail to resolve the module.
      expect(pkg.main).toBe('src/index.ts');
      expect(pkg.types).toBe('src/index.ts');
    });

    it('has no runtime dependencies (zero-dep invariant per task 1.26)', () => {
      // Sanity cross-check with the separate dep_hygiene gate. Same
      // invariant, stated differently — if this fails AND dep_hygiene
      // passes, something has gone deeply wrong in the build system.
      const untyped = pkg as { dependencies?: Record<string, string> };
      expect(untyped.dependencies ?? {}).toEqual({});
    });
  });

  describe('publish config (what npm sees on `npm publish`)', () => {
    it('publishConfig overrides main/types/exports at publish time', () => {
      const pc = pkg.publishConfig;
      expect(pc).toBeDefined();
      expect(pc?.main).toBe('./dist/index.js');
      expect(pc?.types).toBe('./dist/index.d.ts');

      const exp = pc?.exports as
        | { '.': { types?: string; require?: string; default?: string } }
        | undefined;
      expect(exp?.['.']?.types).toBe('./dist/index.d.ts');
      expect(exp?.['.']?.default).toBe('./dist/index.js');
      // `require` is separate from `default` so CJS consumers resolve
      // via the explicit condition — belt + braces for Node ≥ 12 import
      // mapping.
      expect(exp?.['.']?.require).toBe('./dist/index.js');
    });

    it('files whitelist limits tarball to publish-relevant content', () => {
      expect(pkg.files).toBeDefined();
      // Must include dist/ (the build output) + README.md (public-facing
      // pitch) + docs/ (per-feature spec). Must NOT include tests,
      // conformance runner source, or package-internal scaffolding.
      expect(pkg.files).toContain('dist/');
      expect(pkg.files).toContain('README.md');
      expect(pkg.files).toContain('docs/');
      // Negative — directories that must stay local:
      expect(pkg.files).not.toContain('__tests__');
      expect(pkg.files).not.toContain('__tests__/');
      expect(pkg.files).not.toContain('conformance');
      expect(pkg.files).not.toContain('conformance/');
      expect(pkg.files).not.toContain('src');
      expect(pkg.files).not.toContain('src/');
    });

    it('stays private until the maintainer flips the flag manually', () => {
      // The literal `npm publish` is user-action — we keep
      // `"private": true` until the maintainer has credentials loaded
      // and explicitly unlocks. Accidental workspace publishes from CI
      // or a bad script get rejected at the npm level.
      const untyped = pkg as { private?: boolean };
      expect(untyped.private).toBe(true);
    });
  });

  describe('build + prepublish scripts', () => {
    it('build script emits dist/ via a dedicated tsconfig', () => {
      const build = pkg.scripts?.build;
      expect(build).toBeDefined();
      // Enforces the `rm -rf dist` clean-first pattern so stale
      // artefacts don't cross-contaminate a rebuild.
      expect(build).toMatch(/rm\s+-rf\s+dist/);
      expect(build).toMatch(/tsc\s+--project\s+tsconfig\.build\.json/);
    });

    it('prepublishOnly runs build AND tests', () => {
      const pp = pkg.scripts?.prepublishOnly;
      expect(pp).toBeDefined();
      expect(pp).toMatch(/npm run build/);
      expect(pp).toMatch(/npm test/);
    });

    it('tsconfig.build.json exists with publish-appropriate overrides', () => {
      const buildTsPath = resolve(PKG_ROOT, 'tsconfig.build.json');
      expect(existsSync(buildTsPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(buildTsPath, 'utf8')) as {
        compilerOptions?: {
          module?: string;
          declaration?: boolean;
          composite?: boolean;
          outDir?: string;
        };
        exclude?: string[];
      };
      // CJS output — the broadest-compatibility format for npm
      // libraries. If a future task wants dual CJS+ESM, this pins the
      // current state so the migration is a conscious choice.
      expect(cfg.compilerOptions?.module?.toLowerCase()).toBe('commonjs');
      expect(cfg.compilerOptions?.declaration).toBe(true);
      // Must NOT be composite — `tsc --build` from a composite project
      // emits tsbuildinfo state that pollutes the published tarball.
      expect(cfg.compilerOptions?.composite).toBe(false);
      expect(cfg.compilerOptions?.outDir).toBe('dist');
      // Tests, conformance, docs must be excluded — they belong to the
      // development surface, not the published runtime.
      expect(cfg.exclude).toEqual(
        expect.arrayContaining(['**/*.test.ts', 'conformance/**', '__tests__/**']),
      );
    });
  });

  describe('README — npm badges pre-wired for task 10.19 activation', () => {
    it('README.md carries the npm-version badge that auto-activates on first publish', () => {
      const readme = readFileSync(resolve(PKG_ROOT, 'README.md'), 'utf8');
      // The shields.io URL for a package's current npm version.
      // Until the first `npm publish`, this badge renders as "invalid"
      // — which is fine; it's the pre-wire for task 10.19's activation.
      // The key invariant: the URL must address `@dina/protocol` so
      // the badge switches on the right package.
      expect(readme).toMatch(
        /https:\/\/img\.shields\.io\/npm\/v\/@dina\/protocol\.svg/,
      );
      // Crosslink to the npmjs.com package page — so a reader clicking
      // the badge lands on the canonical registry entry, not a 404.
      expect(readme).toMatch(/npmjs\.com\/package\/@dina\/protocol/);
    });

    it('README.md carries a downloads badge pointing at the same package', () => {
      const readme = readFileSync(resolve(PKG_ROOT, 'README.md'), 'utf8');
      // shields.io `npm/dm` = monthly downloads. Starts at 0 after
      // publish, auto-updates. Separate from version badge so either
      // can be removed independently without breaking the other.
      expect(readme).toMatch(
        /https:\/\/img\.shields\.io\/npm\/dm\/@dina\/protocol\.svg/,
      );
    });
  });

  describe('dist smoke — only runs when `npm run build` has populated dist/', () => {
    // Use a dynamic skip rather than a hard fail, so a fresh clone
    // without `npm run build` still passes the gate. The maintainer
    // runs the build as part of `prepublishOnly`; CI runs the build
    // ahead of tests if the release workflow needs it.
    const distIndex = resolve(PKG_ROOT, 'dist', 'index.js');
    const distDts = resolve(PKG_ROOT, 'dist', 'index.d.ts');

    (existsSync(distIndex) ? it : it.skip)(
      'dist/index.js loads via CJS require and exposes the expected surface',
      () => {
        // `require` is synchronous + survives the CJS-in-TS-jest
        // environment. If the build emits ESM-only output, this fails
        // loud — that'd mean `tsconfig.build.json::module` drifted.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const built = require(distIndex) as Record<string, unknown>;
        // Spot-check a handful of known-public exports from src/index.ts.
        expect(typeof built.buildCanonicalPayload).toBe('function');
        expect(typeof built.buildMessageJSON).toBe('function');
        expect(built.SERVICE_TYPE_MSGBOX).toBe('DinaMsgBox');
        expect(built.SERVICE_TYPE_DIRECT_HTTPS).toBe('DinaDirectHTTPS');
        // Bounds check — the public API surface today is ~35 exports;
        // if it drops below 20 the build clearly stripped too much.
        expect(Object.keys(built).length).toBeGreaterThanOrEqual(20);
      },
    );

    (existsSync(distDts) ? it : it.skip)(
      'dist/index.d.ts exists and starts with the auto-generated banner from src/index.ts',
      () => {
        const dts = readFileSync(distDts, 'utf8');
        // First doc-block should carry the same header line as src/,
        // so a reader who lands on the published types recognises the
        // surface. Just checking it starts with `/**` + mentions
        // `@dina/protocol`.
        expect(dts.startsWith('/**')).toBe(true);
        expect(dts).toMatch(/@dina\/protocol/);
      },
    );
  });
});
