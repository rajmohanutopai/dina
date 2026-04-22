/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@dina/test-harness$': '<rootDir>/../test-harness/src/index',
    '^@dina/test-harness/(.*)$': '<rootDir>/../test-harness/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
      useESM: false,
    }],
  },
  // @noble/* and @scure/* are ESM-only — must be transformed for CJS Jest
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble|@scure)/).*/',
  ],
};
