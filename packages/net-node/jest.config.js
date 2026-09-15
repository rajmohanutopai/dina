/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  // The repo-proof verifier test loads ESM-only `@atproto/*` via a runtime
  // dynamic import, which needs `--experimental-vm-modules`; that flag makes
  // jest treat `@noble` as ESM too and breaks the CJS tests here. The flag is
  // global-per-process, so that one test runs in its own pass — see
  // `jest.esm.config.js` and the package `test` script.
  testPathIgnorePatterns: ['/node_modules/', 'repo_proof_verifier'],
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
      useESM: false,
    }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
};
