/**
 * Node driver for the real-Bluesky OAuth round-trip, completed via the
 * user's logged-in Chrome.
 *
 *   npx tsx oauth_chrome_drive.ts start rspam.bsky.social
 *     → runs resolve + discovery + PAR(DPoP) against real bsky.social,
 *       writes the session to /tmp/dina_oauth_session.json, prints the
 *       authorize URL (open it in Chrome where you're logged in, approve).
 *
 *   npx tsx oauth_chrome_drive.ts complete '<full redirect URL or code>'
 *     → reads the session, runs the DPoP-bound token exchange, verifies
 *       sub === resolved DID, prints the proven link + tokens.
 *
 * Exercises the SHIPPING client (`apps/mobile/src/services/atproto_oauth.ts`)
 * — only the read-only handle resolver is a Node shim.
 */

import { readFile, writeFile } from 'node:fs/promises';

import {
  startOAuth,
  completeOAuth,
  type FetchLike,
  type IdentityResolver,
} from '../../apps/mobile/src/services/atproto_oauth';

const SESSION_PATH = '/tmp/dina_oauth_session.json';
const OAUTH_CLIENT = 'https://test-mobile.dinakernel.com';

const fetchFn: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

// Read-only handle→did→pds resolver (the only Node shim).
const nodeResolve: IdentityResolver = (async (identifier: string) => {
  const id = identifier.trim().replace(/^@/, '').replace(/^at:\/\//, '');
  let did = id.startsWith('did:') ? id : '';
  let handle: string | null = id.startsWith('did:') ? null : id;
  if (did === '') {
    const r = await fetch(
      `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(id)}`,
    );
    did = ((await r.json()) as { did: string }).did;
  }
  let pdsUrl = '';
  if (did.startsWith('did:plc:')) {
    const dd = (await (await fetch(`https://plc.directory/${did}`)).json()) as {
      service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
      alsoKnownAs?: string[];
    };
    const svc = (dd.service ?? []).find(
      (s) => s.type === 'AtprotoPersonalDataServer' || (s.id ?? '').endsWith('atproto_pds'),
    );
    pdsUrl = svc?.serviceEndpoint ?? '';
    if (handle === null && Array.isArray(dd.alsoKnownAs) && dd.alsoKnownAs[0]) {
      handle = dd.alsoKnownAs[0].replace(/^at:\/\//, '');
    }
  }
  if (pdsUrl === '') throw new Error(`could not resolve PDS for ${did}`);
  return { did, handle, pdsUrl, rotationKeys: [], alsoKnownAs: [], verificationMethods: {}, services: {} };
}) as never;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'start') {
    const handle = process.argv[3] ?? 'rspam.bsky.social';
    const { authorizeUrl, session } = await startOAuth(handle, {
      fetchFn,
      oauthClientUrl: OAUTH_CLIENT,
      nowSec: Math.floor(Date.now() / 1000),
      resolve: nodeResolve,
    });
    await writeFile(SESSION_PATH, JSON.stringify(session), 'utf-8');
    console.log('RESOLVED DID :', session.did);
    console.log('TOKEN ENDPT  :', session.tokenEndpoint);
    console.log('REDIRECT URI :', session.redirectUri);
    console.log('\n=== OPEN THIS IN CHROME (logged into bsky), APPROVE, copy the redirect URL ===\n');
    console.log(authorizeUrl);
    return;
  }
  if (cmd === 'complete') {
    const arg = process.argv[3] ?? '';
    const query = arg.includes('?') ? arg.split('?')[1] : arg;
    const params = new URLSearchParams(query);
    const code = params.get('code') ?? (arg.startsWith('code=') ? '' : arg);
    const state = params.get('state') ?? '';
    const session = JSON.parse(await readFile(SESSION_PATH, 'utf-8'));
    const result = await completeOAuth(
      session,
      { code, state: state || session.state },
      { fetchFn, nowSec: Math.floor(Date.now() / 1000) },
    );
    console.log('=== TOKEN EXCHANGE OK ===');
    console.log('PROVEN DID   :', result.did);
    console.log('handle       :', result.handle);
    console.log('pdsUrl       :', result.pdsUrl);
    console.log('access token :', result.accessToken.slice(0, 16) + '…');
    console.log('refresh token:', result.refreshToken ? result.refreshToken.slice(0, 12) + '…' : null);
    console.log('sub === resolved DID ✓ (completeOAuth enforces this)');
    return;
  }
  console.error('usage: oauth_chrome_drive.ts start <handle> | complete <redirectUrl|code>');
  process.exit(1);
}

main().catch((err) => {
  console.error('[oauth_chrome_drive] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
