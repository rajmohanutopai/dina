/**
 * What every test against the mock UCP merchant shares (UCP plan §3.19 step
 * 2): the test certificate, a policy socket that reaches loopback through the
 * real Node socket and serves ucp.dev from the recorded release, Dina's UCP
 * identity and the exact profile its publisher serves, and a fresh identity
 * database.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { buyerProfileBytes, dropBoxWebhookUrl, profileUrlForLabel } from '@dina/ucp';

import { createNodePolicySocket } from '../../../../net-socket-node/src';
import { deriveUcpIdentity } from '../../../src/commerce/ucp/identity';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import { RELEASE } from './merchant_fixture';

import type { PolicySocket } from '@dina/net-policy';

const FIXTURES = path.join(__dirname, '../../../../net-socket-node/__tests__/fixtures');
/** Covers `localhost`, `agent.test` and `other.test`; a merchant's origin is a name and a port. */
export const CERT = readFileSync(path.join(FIXTURES, 'localhost.cert.pem'), 'utf8');
export const KEY = readFileSync(path.join(FIXTURES, 'localhost.key.pem'), 'utf8');
export const PROFILE_HOST = 'ucp.test.example';

/** Dina's identity here, and the profile its publisher serves, at the URL the client sends. */
// A node whose publisher has already made generation 0 active.
export const IDENTITY = deriveUcpIdentity(new Uint8Array(32).fill(6), 0);
export const PROFILE_URL = profileUrlForLabel(IDENTITY.label, PROFILE_HOST);
export const PROFILE = buyerProfileBytes({
  keys: [IDENTITY.key.jwk],
  webhookUrl: dropBoxWebhookUrl(IDENTITY.label, PROFILE_HOST),
});
/** The profile host as the shops see it: Dina's real profile at its URL, nothing elsewhere. */
export const fetchProfile = async (url: string) =>
  url === PROFILE_URL ? { status: 200, body: PROFILE } : { status: 404, body: '' };

/** The real Node socket, pointed at loopback for the certificate's names; ucp.dev from the recording. */
export function testSocket(seen: string[] = []): PolicySocket {
  const real = createNodePolicySocket({
    resolve: async () => ['127.0.0.1'],
    isAllowedAddress: (a) => a === '127.0.0.1',
    ca: CERT,
  });
  return async (request) => {
    seen.push(request.url);
    const recorded = RELEASE[request.url];
    if (recorded !== undefined)
      return {
        ok: true,
        status: 200,
        bodyBytes: new TextEncoder().encode(recorded),
        rawHeaders: [['content-type', 'application/json']],
        connectedAddress: '203.0.114.7',
      };
    return real(request);
  };
}

/** A fresh, migrated identity database in a temporary folder. */
export function freshDatabase(name: string): { db: NodeSQLiteAdapter; close: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `ucp-${name}-`));
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'cd'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  return {
    db,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
