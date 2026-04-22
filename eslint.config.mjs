// ESLint flat config (ESLint 9+).
//
// Scope: TS sources under packages/ and apps/home-node-lite/ (and later
// apps/mobile/). The existing polyglot tree (core/, brain/, cli/, msgbox/,
// appview/, tests/, scripts/) is ignored — those services have their own
// linters or are non-TS.
//
// Phase 2 will add a custom rule `dina/port-async-only` that enforces the
// async-everywhere port rule. Hook is wired below under `local` so the rule
// can land without touching this file's shape.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default tseslint.config(
  // 1. Global ignores — do not traverse non-TS trees or generated output.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/.turbo/**',
      // Non-TS services (polyglot repo).
      'core/**',
      'brain/**',
      'cli/**',
      'admin-cli/**',
      'msgbox/**',
      'appview/**',
      'tests/**',
      'scripts/**',
      'docs/**',
      'api/**',
      'deploy/**',
      'demo/**',
      'docker/**',
      'instances/**',
      'proto/**',
      'secrets/**',
      // Generated TS artefacts (Phase 1d).
      '**/gen/**',
      '**/*.gen.ts',
    ],
  },

  // 2. Recommended base rules for plain JS/TS.
  js.configs.recommended,

  // 3. TypeScript strict + stylistic recommended — the "strict" per task 0.9.
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,

  // 4. TypeScript file options + import-order enforcement.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      // Import hygiene — keeps workspace imports readable and prevents
      // accidental reach-across (e.g. brain/ pulling from a *-node adapter).
      'import/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'type',
          ],
          pathGroups: [{ pattern: '@dina/**', group: 'internal', position: 'before' }],
          pathGroupsExcludedImportTypes: ['type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-duplicates': 'error',
      'import/no-cycle': ['error', { maxDepth: 10 }],

      // Small per-project relaxations on top of tseslint.strict defaults.
      // Unused args prefixed with _ are explicit — matches Go convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Port-async rule placeholder — Phase 2 replaces this with a real
      // custom rule under a local plugin (tracked in task doc § Phase 2).
      // Until then, tseslint.strict catches most accidental sync-to-async
      // signature drift.
    },
  },

  // 5. Config files themselves (this file, prettierrc, etc.) — relax a few
  //    rules that don't apply to a flat-config module.
  {
    files: ['eslint.config.mjs', '*.config.{js,mjs,cjs,ts}'],
    rules: {
      'import/no-default-export': 'off',
    },
  },

  // 6. Transport isolation for @dina/brain (task 1.33).
  //    packages/brain/src/** must import CoreClient / AppViewClient only,
  //    never platform transport libraries (fetch/undici/ws/node:http/https)
  //    or server frameworks (@fastify/*). The pure-brain package stays
  //    runtime-agnostic; HTTP + WebSocket concerns are injected by
  //    apps/home-node-lite/brain-server/ (Node) or apps/mobile/ (Expo).
  //
  //    **Severity: `warn` — temporarily.** Six existing call-sites in
  //    `appview_client/http.ts`, `pds/account.ts`, `pds/publisher.ts` still
  //    call `globalThis.fetch`. Task 1.32 (still open) refactors those to
  //    use the injected HttpClient; once 1.32 lands and the violation
  //    count hits zero, flip every severity in this block to `error`.
  //    Landing as `warn` now surfaces the 6 spots that need refactoring
  //    in lint output without breaking CI on HEAD.
  {
    files: ['packages/brain/src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          paths: [
            { name: 'undici',      message: 'Transport belongs in the server app; use the injected HttpClient.' },
            { name: 'ws',          message: 'WebSocket transport belongs in the server app; use the injected AppViewClient / notify bridge.' },
            { name: 'node:http',   message: 'Node stdlib HTTP is out of scope for @dina/brain; use the injected HttpClient.' },
            { name: 'node:https',  message: 'Node stdlib HTTPS is out of scope for @dina/brain; use the injected HttpClient.' },
          ],
          patterns: [
            { group: ['@fastify/*'], message: 'Server framework is app-layer; @dina/brain stays runtime-agnostic.' },
            { group: ['fastify'],    message: 'Server framework is app-layer; @dina/brain stays runtime-agnostic.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'warn',
        { name: 'fetch', message: 'Use the injected HttpClient; @dina/brain must not depend on the platform fetch global.' },
      ],
      // `no-restricted-globals` catches bare `fetch(…)` only — these selectors
      // close the common circumvention paths (`globalThis.fetch`, `window.fetch`,
      // `self.fetch`). Motivated circumvention (`eval`, dynamic property access)
      // can always bypass lint; the goal here is catching accidental regression.
      'no-restricted-syntax': [
        'warn',
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message: 'Use the injected HttpClient; @dina/brain must not call globalThis.fetch.',
        },
        {
          selector: "MemberExpression[object.name='window'][property.name='fetch']",
          message: 'Use the injected HttpClient; @dina/brain must not call window.fetch.',
        },
        {
          selector: "MemberExpression[object.name='self'][property.name='fetch']",
          message: 'Use the injected HttpClient; @dina/brain must not call self.fetch.',
        },
      ],
    },
  },
);
