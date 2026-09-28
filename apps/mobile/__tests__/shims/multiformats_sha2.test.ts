/**
 * The multiformats SHA-2 shim (§5.C1-mobile). On the device the repo-proof
 * self-check failed with "Cannot read property 'digest' of undefined": Metro
 * picked multiformats' browser hasher, which needs `crypto.subtle`, absent on
 * Hermes, so the Plugins door never opened. Pinned: Metro swaps that one file
 * for the shim and nothing else, and the shim hashes exactly as SHA-2 does
 * under the same multihash codes.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { sha256, sha512 } from '../../src/shims/multiformats_sha2';

const projectRoot = path.resolve(__dirname, '..', '..');
const shimPath = path.join(projectRoot, 'src', 'shims', 'multiformats_sha2.js');

type Resolution = { type: 'sourceFile'; filePath: string } | { type: 'empty' };
type ResolveRequest = (context: unknown, moduleName: string, platform: string | null) => Resolution;

function metroResolve(): ResolveRequest {
  // The app's real Metro config; its hook hands anything it does not shim to
  // the context's resolver, faked here to answer with a chosen file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require('../../metro.config.js') as {
    resolver: { resolveRequest: ResolveRequest };
  };
  return config.resolver.resolveRequest;
}

const contextAnswering = (filePath: string) => ({
  resolveRequest: (): Resolution => ({ type: 'sourceFile', filePath }),
});

describe('Metro swaps the browser SHA-2 hasher for the shim', () => {
  const browserFile = path.join(
    projectRoot,
    'node_modules',
    'multiformats',
    'dist',
    'src',
    'hashes',
    'sha2-browser.js',
  );

  it.each(['ios', 'android', 'web'])('on %s, by package subpath or relative import', (platform) => {
    const resolve = metroResolve();
    for (const name of ['multiformats/hashes/sha2', './sha2.js']) {
      expect(resolve(contextAnswering(browserFile), name, platform)).toEqual({
        type: 'sourceFile',
        filePath: shimPath,
      });
    }
  });

  it('leaves every other file alone', () => {
    const other = path.join(
      projectRoot,
      'node_modules',
      'multiformats',
      'dist',
      'src',
      'hashes',
      'hasher.js',
    );
    expect(metroResolve()(contextAnswering(other), 'multiformats/hashes/hasher', 'ios')).toEqual({
      type: 'sourceFile',
      filePath: other,
    });
  });
});

describe('the shim hashes as SHA-2 does', () => {
  const data = new TextEncoder().encode('dina repo proof');

  it('sha2-256: code 0x12, the SHA-256 digest', async () => {
    const mh = await sha256.digest(data);
    expect(mh.code).toBe(0x12);
    expect(Buffer.from(mh.digest).toString('hex')).toBe(
      createHash('sha256').update(data).digest('hex'),
    );
  });

  it('sha2-512: code 0x13, the SHA-512 digest', async () => {
    const mh = await sha512.digest(data);
    expect(mh.code).toBe(0x13);
    expect(Buffer.from(mh.digest).toString('hex')).toBe(
      createHash('sha512').update(data).digest('hex'),
    );
  });
});
