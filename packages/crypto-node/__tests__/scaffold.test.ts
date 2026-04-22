/**
 * Aggregate-shape pin for `@dina/crypto-node`.
 *
 * Tasks 3.21–3.28 all landed. Per-primitive tests live in dedicated
 * files (ed25519.test.ts, x25519.test.ts, secp256k1.test.ts,
 * hashes.test.ts, hkdf.test.ts, sealed-box.test.ts, argon2.test.ts,
 * random.test.ts). This file only pins the aggregate type shape so
 * future port additions (e.g. task 3.30 cross-runtime conformance)
 * can't silently drop a method from the aggregate.
 */

import type { CryptoAdapterNode } from '../src';
import { NodeCryptoAdapter } from '../src';

describe('NodeCryptoAdapter — aggregate type', () => {
  it('constructs and satisfies CryptoAdapterNode at compile + runtime', () => {
    const adapter: CryptoAdapterNode = new NodeCryptoAdapter();
    expect(adapter).toBeInstanceOf(NodeCryptoAdapter);
  });
});
