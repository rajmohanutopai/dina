/**
 * Metro shim for `node:dns/promises` (§5.C1-mobile).
 *
 * `@atproto/identity` imports DNS only for HANDLE resolution (`_atproto` TXT
 * records). The repo-proof verifier resolves DIDs, never handles, so this path
 * is never taken on the phone; the shim exists so Metro can resolve the static
 * import. A call throws loudly rather than returning a fabricated answer.
 */
const unavailable = () => {
  throw new Error('dns is not available on this platform');
};
module.exports = {
  resolveTxt: unavailable,
  resolve: unavailable,
  lookup: unavailable,
};
