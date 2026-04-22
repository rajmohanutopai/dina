/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
      useESM: false,
    }],
  },
  // @noble/* and @scure/* ship ESM-only. transformIgnorePatterns excepts
  // them so ts-jest transforms their `import/export` into CJS. Required
  // by __tests__/conformance_vectors.test.ts (tasks 10.6, 10.9).
  // `/dist/` excluded so the npm-publish-ready gate (task 10.18) can
  // `require()` already-compiled CJS output without ts-jest re-processing it.
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble|@scure)/).*/',
    '/dist/',
  ],
};
