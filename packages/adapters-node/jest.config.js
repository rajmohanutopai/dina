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
  // esbuild runs bundling in-process — no ESM transforms needed for it,
  // but its consumed source (@dina/*-node packages) pulls @noble/* which
  // ships ESM-only; transformIgnore lets Jest's loader handle them.
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
  // Bundling takes a bit of time; give tests a wider budget.
  testTimeout: 30000,
};
