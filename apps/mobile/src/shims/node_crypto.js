/**
 * Metro shim for `node:crypto` (React Native has no Node crypto).
 *
 * Only the surface used by `@dina/brain/src/diagnostics/trace_correlation.ts`
 * is implemented: `randomBytes(n)` returning an object with a
 * `.toString('hex')` method. Backed by the already-installed
 * `crypto.getRandomValues` polyfill (`react-native-get-random-values`,
 * loaded in `src/polyfills.ts`).
 *
 * If a future caller asks for more (createHash, createHmac, etc.), add
 * it here rather than reaching for a heavyweight Node-crypto polyfill —
 * the noble/scure stack already covers our hashing/signing needs and
 * is what the rest of the codebase uses.
 */

function randomBytes(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError('randomBytes: n must be a positive integer');
  }
  const arr = new Uint8Array(n);
  globalThis.crypto.getRandomValues(arr);
  arr.toString = function (encoding) {
    if (encoding === 'hex') {
      let s = '';
      for (let i = 0; i < this.length; i++) {
        s += this[i].toString(16).padStart(2, '0');
      }
      return s;
    }
    throw new Error(`node_crypto shim: only 'hex' encoding is supported (got ${encoding})`);
  };
  return arr;
}

module.exports = { randomBytes };
module.exports.default = module.exports;
