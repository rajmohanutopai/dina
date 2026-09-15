/**
 * Metro shim for `@atproto/common` (§5.C1-mobile).
 *
 * `@atproto/repo` imports exactly one thing from the Node-flavoured
 * `@atproto/common`: `subsystemLogger`, for a `log.info` when a repo loads.
 * The real package's barrel drags `pino`, `node:fs`, `node:stream` and
 * `node:zlib` into the bundle. This shim satisfies the one import with a
 * silent logger; the phone's own audit trail is Core's, not a library's.
 */
const silent = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silent;
  },
};
module.exports = {
  subsystemLogger: () => silent,
};
