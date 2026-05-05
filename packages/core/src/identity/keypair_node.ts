/**
 * Node-only service key file I/O. Reads/writes Ed25519 PEM files.
 *
 * Portable PEM encode/decode + sign/verify live in `./keypair.ts`. This
 * module is the file-backed adapter and may not be imported from portable
 * Core source. It is exposed publicly through the `@dina/core/node`
 * package subpath.
 */

import * as fs from 'fs';
import * as path from 'path';

import { keypairToPEM, keypairFromPEM, type IdentityKeypair } from './keypair';

/**
 * Write service keypair PEM files to a directory.
 * Creates: `{dir}/{name}.key` (private) and `{dir}/{name}.pub` (public).
 */
export function writeServiceKey(dir: string, name: string, keypair: IdentityKeypair): void {
  fs.mkdirSync(dir, { recursive: true });
  const { privatePEM, publicPEM } = keypairToPEM(keypair);
  fs.writeFileSync(path.join(dir, `${name}.key`), privatePEM, 'utf-8');
  fs.writeFileSync(path.join(dir, `${name}.pub`), publicPEM, 'utf-8');
}

/**
 * Load service keypair from PEM files.
 * Reads `{dir}/{name}.key` and `{dir}/{name}.pub`.
 */
export function loadServiceKey(dir: string, name: string): IdentityKeypair {
  const privPath = path.join(dir, `${name}.key`);
  const pubPath = path.join(dir, `${name}.pub`);
  if (!fs.existsSync(privPath)) {
    throw new Error(`keypair: private key file not found — ${privPath}`);
  }
  if (!fs.existsSync(pubPath)) {
    throw new Error(`keypair: public key file not found — ${pubPath}`);
  }
  const privatePEM = fs.readFileSync(privPath, 'utf-8');
  const publicPEM = fs.readFileSync(pubPath, 'utf-8');
  return keypairFromPEM(privatePEM, publicPEM);
}
