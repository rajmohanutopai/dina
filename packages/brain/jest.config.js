/** @type {import('jest').Config} */
module.exports = {
  ...require('../../jest.memory'),
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@dina/test-harness$': '<rootDir>/../test-harness/src/index',
    '^@dina/test-harness/(.*)$': '<rootDir>/../test-harness/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  // tsconfig.jest.json sets `isolatedModules`, so ts-jest transpiles each file
  // without type checking it: far less memory per worker. `npm run typecheck`
  // (tsc --noEmit over src and __tests__) is where type errors are caught.
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  // @noble/* and @scure/* are ESM-only — must be transformed for CJS Jest
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble|@scure)/).*/',
  ],
};
