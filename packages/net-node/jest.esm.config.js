/**
 * A second jest pass for the ONE test that needs Node's ESM loader: the
 * repo-proof verifier loads ESM-only `@atproto/*` via a runtime dynamic
 * `import()`, which requires `--experimental-vm-modules` (set in the package
 * `test` script). That flag conflicts with the CJS `@noble` tests, so this pass
 * runs the verifier test alone. The verifier SOURCE still compiles to CommonJS;
 * only the module load is dynamic.
 *
 * @type {import('jest').Config}
 */
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: ['**/repo_proof_verifier.test.ts'],
};
