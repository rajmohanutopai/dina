/**
 * Metro shim for multiformats' SHA-2 hashers (§5.C1-mobile).
 *
 * Metro resolves `multiformats/hashes/sha2` to its browser build, which hashes
 * with `crypto.subtle.digest`. Hermes has no `crypto.subtle`, so every CID
 * check in `@atproto/repo` threw ("Cannot read property 'digest' of
 * undefined"), the repo-proof self-check failed on the device, and the Plugins
 * door stayed closed. Same hashers, same multihash codes, computed with
 * `@noble/hashes` — the audited library the rest of the app already hashes
 * with.
 */
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { from } from 'multiformats/hashes/hasher';

export const sha256 = from({
  name: 'sha2-256',
  code: 0x12,
  encode: (data) => nobleSha256(data),
});

export const sha512 = from({
  name: 'sha2-512',
  code: 0x13,
  encode: (data) => nobleSha512(data),
});
