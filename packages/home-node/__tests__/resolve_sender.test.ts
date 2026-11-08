/**
 * TT-01 / TT-S4: `makeResolveSender` tells "could not find out" from "found
 * nothing", and refreshes a cached key at most once a minute per DID.
 */
import { publicKeyToMultibase } from '@dina/core';

import { makeResolveSender } from '../src/resolve_sender';

const DID = 'did:plc:peer';
const key = (b: number): Uint8Array => new Uint8Array(32).fill(b);
const doc = (k: Uint8Array) => ({
  document: {
    verificationMethod: [
      { id: `${DID}#dina_signing`, type: 'Multikey', publicKeyMultibase: publicKeyToMultibase(k) },
    ],
  },
});

function build(resolve: (did: string, options?: { fresh?: boolean }) => Promise<unknown>) {
  return makeResolveSender({
    selfDID: 'did:plc:me',
    selfPublicKey: key(9),
    resolver: { resolve } as never,
    onResolveError: () => undefined,
  });
}

describe('makeResolveSender', () => {
  it('an outage is unresolved, never an empty answer the pipeline could read as bad', async () => {
    const sender = await build(async () => {
      throw new Error('PLC 503');
    })(DID);
    expect(sender.unresolved).toBe(true);
    expect(sender.keys).toEqual([]);
  });

  it('a directory that says no such DID is a real answer', async () => {
    const gone = Object.assign(new Error('not found'), { unresolvable: true });
    const sender = await build(async () => {
      throw gone;
    })(DID);
    expect(sender.unresolved).toBeUndefined();
    expect(sender.keys).toEqual([]);
  });

  it('a key from the network offers no refresh', async () => {
    const sender = await build(async () => ({ ...doc(key(1)), source: 'network' }))(DID);
    expect(sender.keys).toEqual([key(1)]);
    expect(sender.refresh).toBeUndefined();
  });

  it('a cached key refreshes against the directory, and only once a minute', async () => {
    const reads: (boolean | undefined)[] = [];
    const resolveSender = build(async (_d, options) => {
      reads.push(options?.fresh);
      return options?.fresh === true
        ? { ...doc(key(2)), source: 'network' }
        : { ...doc(key(1)), source: 'cache' };
    });
    const first = await resolveSender(DID);
    expect(first.keys).toEqual([key(1)]);
    const fresh = await first.refresh!();
    expect(fresh.keys).toEqual([key(2)]);
    expect(reads).toEqual([undefined, true]);
    // A second bad signature inside the minute: no second directory read.
    expect((await resolveSender(DID)).refresh).toBeUndefined();
  });

  it('a refresh during an outage is unresolved', async () => {
    const resolveSender = build(async (_d, options) => {
      if (options?.fresh === true) throw new Error('PLC 503');
      return { ...doc(key(1)), source: 'cache' };
    });
    const fresh = await (await resolveSender(DID)).refresh!();
    expect(fresh.unresolved).toBe(true);
  });
});
