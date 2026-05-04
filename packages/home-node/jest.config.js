/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Shared runtime composition imports Core/Brain sources, which depend on
  // @noble/@scure ESM modules. Keep the transform rule aligned with server
  // adapter tests so package-level runtime tests execute the same code.
  transformIgnorePatterns: ['/node_modules/(?!(@noble|@scure)/).*/'],
};
