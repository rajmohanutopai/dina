/**
 * Home-node identity bootstrap.
 *
 * Composes the two sides that make a dina-mobile home node
 * reachable on the AT Protocol network:
 *
 *   1. A self-managed `did:plc:…` registered on the PLC directory. The
 *      phone's Ed25519 signing key is the DID's `verificationMethods.atproto`
 *      so D2D envelope verification and PDS record authorship both use
 *      the same key. The DID's services declare our MsgBox endpoint so
 *      peers can discover where to route traffic.
 *
 *   2. A PDS account at `{handle, password}` bound to the did:plc above,
 *      used for record publishing (ServicePublisher) and later for any
 *      XRPC that needs a signed session.
 *
 * `ensureNodeIdentity` is idempotent:
 *   - If a session for `{handle, password}` already exists on the PDS, it
 *     is returned untouched (no PLC write, no createAccount). The phone
 *     can re-bootstrap on every launch safely.
 *   - When the account doesn't exist, the DID is registered first (so a
 *     half-registered-but-no-account state never leaks) and then the
 *     account is created with `did: <ourDID>`.
 *
 * Callers must persist `signingSeed` + `rotationSeed` in the device
 * keychain between runs — re-generating seeds would produce a NEW DID on
 * the next launch, orphaning the PDS account.
 */

import { createDIDPLC } from '../../../core/src/identity/directory';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import type { IdentityKeypair } from '../../../core/src/identity/keypair';
import { PDSAccountClient, PDSAccountError, type PDSSession } from '../pds/account';

export interface EnsureNodeIdentityParams {
  /** PDS handle, e.g. `busdriver.test-pds.dinakernel.com`. */
  handle: string;
  /** PDS account password. Never logged. */
  password: string;
  /** Base URL of the PDS (trailing slash stripped). */
  pdsUrl: string;
  /** PLC directory URL. Default `https://plc.directory`. */
  plcUrl?: string;
  /** MsgBox WebSocket endpoint published in the did:plc services map. */
  msgboxEndpoint?: string;
  /** Ed25519 signing seed (32 bytes). Becomes the DID's atproto signing key. */
  signingSeed: Uint8Array;
  /** secp256k1 rotation seed. Required for self-managed PLC registration. */
  rotationSeed: Uint8Array;
  /** Optional email (some PDSes require it for account creation). */
  email?: string;
  /** Optional invite code (when PDS is invite-gated). */
  inviteCode?: string;
  /** Injectable fetch for tests + custom TLS configs. */
  fetch?: typeof globalThis.fetch;
}

export interface NodeIdentity {
  /** did:plc:… stable identifier for this home node. */
  did: string;
  /** Ed25519 keypair — private seed + derived public key. */
  signingKeypair: IdentityKeypair;
  /** Authenticated PDS session (access + refresh JWTs, handle, did). */
  pdsSession: PDSSession;
  /** True when a fresh PDS account was created this call. */
  accountCreated: boolean;
  /** True when a new PLC operation was registered this call. */
  plcRegistered: boolean;
}

/**
 * Ensure a home-node identity is live on the network.
 *
 * Flow:
 *   - If `createSession(handle, password)` succeeds → return existing.
 *   - Else register the DID on PLC, then `createAccount` with that DID.
 */
export async function ensureNodeIdentity(params: EnsureNodeIdentityParams): Promise<NodeIdentity> {
  validateParams(params);

  const accountClient = new PDSAccountClient({
    pdsUrl: params.pdsUrl,
    fetch: params.fetch,
  });

  const signingKeypair: IdentityKeypair = {
    privateKey: params.signingSeed,
    publicKey: getPublicKey(params.signingSeed),
  };

  // Fast path: account already registered — just log in.
  const existing = await tryExistingSession(accountClient, params);
  if (existing !== null) {
    return {
      did: existing.did,
      signingKeypair,
      pdsSession: existing,
      accountCreated: false,
      plcRegistered: false,
    };
  }

  // Slow path: register the DID on PLC, then create the PDS account.
  const plcResult = await createDIDPLC(
    {
      signingKey: params.signingSeed,
      rotationSeed: params.rotationSeed,
      msgboxEndpoint: params.msgboxEndpoint,
      handle: params.handle,
    },
    {
      plcURL: params.plcUrl,
      fetch: params.fetch,
    },
  );

  const session = await accountClient.createAccount({
    handle: params.handle,
    password: params.password,
    email: params.email,
    inviteCode: params.inviteCode,
    did: plcResult.did,
  });

  if (session.did !== plcResult.did) {
    // The PDS returned a different DID than we asked for — a
    // misconfiguration (e.g. the PDS ignored our did parameter and minted
    // its own). Fail loudly: the home node would be bound to a DID that
    // doesn't own the PLC record we just registered.
    throw new PDSAccountError(
      `ensureNodeIdentity: PDS returned did=${session.did}, expected ${plcResult.did}`,
      null,
    );
  }

  return {
    did: plcResult.did,
    signingKeypair,
    pdsSession: session,
    accountCreated: true,
    plcRegistered: true,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateParams(p: EnsureNodeIdentityParams): void {
  if (!p.handle) throw new Error('ensureNodeIdentity: handle is required');
  if (!p.password) throw new Error('ensureNodeIdentity: password is required');
  if (!p.pdsUrl) throw new Error('ensureNodeIdentity: pdsUrl is required');
  if (!p.signingSeed || p.signingSeed.length !== 32) {
    throw new Error('ensureNodeIdentity: signingSeed must be 32 bytes');
  }
  if (!p.rotationSeed || p.rotationSeed.length !== 32) {
    throw new Error('ensureNodeIdentity: rotationSeed must be 32 bytes');
  }
}

/**
 * Try to log in with the supplied credentials. Returns the session on
 * success; returns null when the account doesn't exist (so the caller
 * can fall through to create-account). Re-throws every other failure —
 * a bad password should NOT silently trigger account creation.
 */
async function tryExistingSession(
  client: PDSAccountClient,
  params: EnsureNodeIdentityParams,
): Promise<PDSSession | null> {
  try {
    return await client.createSession({
      identifier: params.handle,
      password: params.password,
    });
  } catch (err) {
    if (err instanceof PDSAccountError && isMissingAccount(err)) {
      return null;
    }
    throw err;
  }
}

function isMissingAccount(err: PDSAccountError): boolean {
  if (err.status !== 400) return false;
  return err.xrpcError === 'AccountNotFound' || err.xrpcError === 'InvalidIdentifier';
}
