/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  moduleNameMapper: {
    // Donor tests were authored in `dina-mobile/packages/app/__tests__/`, where
    // `../../../core/src/…` resolved to `dina-mobile/packages/core/src/…`.
    // Post-move (apps/mobile/__tests__/), that same relative path goes to
    // `apps/core/src/…` which doesn't exist. Redirect to the workspace's
    // `packages/core/` via moduleNameMapper instead of rewriting ~190 imports
    // in 82 test files; the source-code swap to `@dina/core` package imports
    // is a deliberate larger refactor for Phase 2 cleanup.
    '^\\.\\./\\.\\./\\.\\./core/(.*)$': '<rootDir>/../../packages/core/$1',
    '^\\.\\./\\.\\./\\.\\./brain/(.*)$': '<rootDir>/../../packages/brain/$1',
    // Same fix for the `@dina/test-harness` package name — donor's mapper
    // pointed at `<rootDir>/../test-harness` (sibling-in-packages); now it's
    // two levels up + into `packages/`.
    '^@dina/test-harness$': '<rootDir>/../../packages/test-harness/src/index',
    '^@dina/test-harness/(.*)$': '<rootDir>/../../packages/test-harness/src/$1',
    // Native mocks live alongside the tests, paths unchanged.
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^react-native-keychain$': '<rootDir>/__mocks__/react-native-keychain.ts',
    '^expo-file-system$': '<rootDir>/__mocks__/expo-file-system.ts',
    '^expo-notifications$': '<rootDir>/__mocks__/expo-notifications.ts',
    '^@expo/vector-icons$': '<rootDir>/__mocks__/expo-vector-icons.ts',
    '^expo-router$': '<rootDir>/__mocks__/expo-router.ts',
  },
  transform: {
    // `isolatedModules: true` tells ts-jest to transpile each file in
    // isolation without cross-file type resolution. The donor tests use
    // `../../../core/src/...` relative imports that TypeScript would try
    // to resolve at compile time and fail (post-move layout); `isolatedModules`
    // hands the path strings through to Jest's moduleNameMapper which
    // redirects them at runtime. Trade-off: cross-file type errors in the
    // tests are silenced here — the separate `npm run typecheck` + the
    // per-package `tsc --noEmit` catch them at their proper layer.
    //
    // `module: 'commonjs'` + `jsx: 'react'` overrides the workspace
    // tsconfig (which pins `module: 'preserve'` + `jsx: 'react-native'`
    // for Metro). Jest's runtime is CommonJS and there's no Metro
    // pipeline, so ts-jest needs to emit fully-transformed JSX as
    // React.createElement calls.
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: { module: 'commonjs', jsx: 'react' },
        isolatedModules: true,
      },
    ],
    // Transform ESM-only @noble / @scure / ai / @ai-sdk packages so ts-jest
    // can consume their `.js` exports (otherwise Jest chokes on ESM syntax).
    '^.+\\.js$': [
      'ts-jest',
      {
        tsconfig: { module: 'commonjs', jsx: 'react' },
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(@noble|@scure|ai|@ai-sdk)/)'],
};
