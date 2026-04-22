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
  // @noble/* and @scure/* ship ESM-only. Let ts-jest transform them to
  // CJS so the integration test (core_integration.test.ts) can import
  // @dina/core, which transitively pulls those packages.
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
};
