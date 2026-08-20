/**
 * Google service-account → access-token minter (OAuth 2.0 JWT-bearer).
 *
 * The Play Integrity decode + Device Recall APIs authenticate with a
 * short-lived OAuth access token minted from a service-account key. We
 * build the RS256 assertion directly over node:crypto and exchange it at
 * the token endpoint — same "no JWT library, smallest surface around the
 * secret" posture as the DeviceCheck ES256 signer.
 *
 * The minted access token is cached until shortly before it expires, so
 * a burst of claims shares one token exchange. A failed exchange throws;
 * the PlayIntegrity adapter maps that to 'unavailable' (transient), never
 * to a device refusal — our own misconfig must not brick a real device.
 *
 * Privacy: the service-account private key is never logged; access
 * tokens are held in memory only.
 */

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export interface GoogleServiceAccount {
  clientEmail: string;
  /** PKCS8 PEM contents of the service-account private key. */
  privateKeyPem: string;
}

export interface GoogleAccessTokenMinterOptions {
  serviceAccount: GoogleServiceAccount;
  /** OAuth scope, e.g. https://www.googleapis.com/auth/playintegrity */
  scope: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Refresh this many ms before the token's real expiry (default 60s). */
  skewMs?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the signed RS256 JWT assertion for the token exchange. Exported
 * for tests so the signature can be verified against the public key
 * without a live token endpoint.
 */
export function buildServiceAccountAssertion(opts: {
  clientEmail: string;
  privateKeyPem: string;
  scope: string;
  nowMs: number;
  lifetimeSec?: number;
}): string {
  const iat = Math.floor(opts.nowMs / 1000);
  const exp = iat + (opts.lifetimeSec ?? 3600);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        iss: opts.clientEmail,
        scope: opts.scope,
        aud: TOKEN_URL,
        iat,
        exp,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(opts.privateKeyPem);
  // RS256 = RSASSA-PKCS1-v1_5 over SHA-256, which is node's default RSA
  // padding for sign() — no dsaEncoding needed (that is an EC concern).
  const sig = cryptoSign('sha256', Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

interface CachedToken {
  accessToken: string;
  /** Absolute ms after which the cached token must not be reused. */
  notAfterMs: number;
}

export class GoogleAccessTokenMinter {
  private readonly opts: GoogleAccessTokenMinterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly skewMs: number;
  private cached: CachedToken | null = null;
  /** Coalesce concurrent mints onto one in-flight exchange. */
  private inFlight: Promise<string> | null = null;

  constructor(opts: GoogleAccessTokenMinterOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.skewMs ?? 60_000;
  }

  /**
   * Return a valid access token, minting one if the cache is empty or
   * near expiry. Throws on any exchange failure (bad key, network, non
   * 200) — the caller treats a throw as transient.
   */
  async getAccessToken(): Promise<string> {
    if (this.cached !== null && this.now() < this.cached.notAfterMs) {
      return this.cached.accessToken;
    }
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.exchange().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async exchange(): Promise<string> {
    const assertion = buildServiceAccountAssertion({
      clientEmail: this.opts.serviceAccount.clientEmail,
      privateKeyPem: this.opts.serviceAccount.privateKeyPem,
      scope: this.opts.scope,
      nowMs: this.now(),
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent(JWT_BEARER_GRANT)}&assertion=${assertion}`,
    });
    if (res.status !== 200) {
      throw new Error(`google token exchange failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('google token exchange returned no access_token');
    }
    const expiresInSec =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 3600;
    this.cached = {
      accessToken: body.access_token,
      notAfterMs: this.now() + expiresInSec * 1000 - this.skewMs,
    };
    return body.access_token;
  }
}
