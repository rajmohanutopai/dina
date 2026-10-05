/** @type {import('jest').Config} */
module.exports = {
  ...require('../../jest.memory'),
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
        useESM: false,
      },
    ],
  },
  // @noble/* ships ESM-only; the tests use it to sign and verify vectors
  // (dev-only — src/ stays zero-dep and takes crypto as injected callbacks).
  transformIgnorePatterns: ['/node_modules/(?!(@noble)/).*/', '/dist/'],
};
