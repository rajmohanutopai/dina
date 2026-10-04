/** @type {import('jest').Config} */
module.exports = {
  ...require('../../../jest.memory'),
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  // tsconfig.jest.json sets `isolatedModules`, so ts-jest transpiles each file
  // without type checking it: far less memory per worker. `npm run typecheck`
  // (tsc --noEmit over src and __tests__) is where type errors are caught.
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.jest.json',
      useESM: false,
    }],
  },
  // Cross-package source imports hit @noble/* ESM — transform them.
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
};
