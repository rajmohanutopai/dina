/**
 * Metro shim for `node:timers/promises` (§5.C1-mobile).
 *
 * `@atproto/repo`'s CAR reader awaits `setImmediate()` every 25 blocks to yield
 * the event loop. React Native provides a callback-style `setImmediate`
 * global; this exposes the promise form the library imports. Nothing else from
 * the module is used by the verification path.
 */
module.exports = {
  setImmediate: () =>
    new Promise((resolve) => {
      if (typeof globalThis.setImmediate === 'function') globalThis.setImmediate(resolve);
      else setTimeout(resolve, 0);
    }),
};
