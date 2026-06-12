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
  // Cross-package source imports hit @noble/* ESM — transform them.
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
};
