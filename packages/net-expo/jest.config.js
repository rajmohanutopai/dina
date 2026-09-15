/**
 * Jest for the Expo network adapter. Its one suite today is the phone's
 * repo-proof verifier, which imports the ESM-only `@atproto/*` STATICALLY (that
 * is what Metro needs). So this pass runs as ESM: ts-jest emits ES modules,
 * `.ts` is treated as ESM, and the package `test` script sets
 * `--experimental-vm-modules`. Under Node this exercises the same static-import
 * module the phone bundles; what it cannot show is Hermes at runtime — a
 * device build does that.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json', useESM: true }],
  },
  // Workspace packages are symlinks into `packages/` (transformed as TS);
  // everything else in node_modules ships as JS and is loaded as-is.
  transformIgnorePatterns: ['/node_modules/(?!(@dina)/).*/'],
};
