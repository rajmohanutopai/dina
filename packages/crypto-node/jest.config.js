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
  // @noble/* packages ship ESM-only; must be transformed for CJS Jest.
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
};
