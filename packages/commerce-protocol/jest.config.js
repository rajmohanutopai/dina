/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        useESM: false,
      },
    ],
  },
  // @noble/* ships ESM-only; ts-jest must transform it for the
  // digest/vector tests (dev-only dep — src/ stays zero-dep).
  transformIgnorePatterns: ['/node_modules/(?!(@noble)/).*/', '/dist/'],
};
