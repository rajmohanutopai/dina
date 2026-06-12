/**
 * Apple DeviceCheck adapter — the real `DeviceState`.
 *
 * Two endpoints, one auth scheme:
 *   POST {base}/v1/query_two_bits   — validates the token AND returns
 *                                     bit state (one call does both;
 *                                     an invalid token is a 400-class
 *                                     response, never a throw for us).
 *   POST {base}/v1/update_two_bits  — sets bit0 = claimed.
 *
 * Auth: ES256 JWT signed with the .p8 key (kid = key id, iss = team
 * id). Implemented directly over node:crypto — this box deliberately
 * carries no JWT library (smallest possible dependency surface around
 * the secrets).
 *
 * Privacy: device tokens are request-scoped and never logged.
 */

import { createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';

import type { DeviceState } from './ports';

const BASES = {
  development: 'https://api.development.devicecheck.apple.com',
  production: 'https://api.devicecheck.apple.com',
} as const;

export interface DeviceCheckOptions {
  teamId: string;
  keyId: string;
  /** PKCS8 PEM contents of the .p8. */
  privateKeyPem: string;
  env: keyof typeof BASES;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a short-lived ES256 JWT for the DeviceCheck API. Exported for tests. */
export function buildDeviceCheckJWT(opts: {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  nowMs: number;
}): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: opts.keyId })));
  const payload = b64url(
    Buffer.from(JSON.stringify({ iss: opts.teamId, iat: Math.floor(opts.nowMs / 1000) })),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(opts.privateKeyPem);
  // JOSE ES256 wants the raw (r||s) signature, not ASN.1/DER.
  const sig = cryptoSign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(sig)}`;
}

export class DeviceCheckClient implements DeviceState {
  private readonly opts: DeviceCheckOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: DeviceCheckOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    const jwt = buildDeviceCheckJWT({
      teamId: this.opts.teamId,
      keyId: this.opts.keyId,
      privateKeyPem: this.opts.privateKeyPem,
      nowMs: this.now(),
    });
    return this.fetchImpl(`${BASES[this.opts.env]}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async check(token: string): Promise<'invalid' | 'unavailable' | { claimed: boolean }> {
    let res: Response;
    try {
      res = await this.post('/v1/query_two_bits', {
        device_token: token,
        transaction_id: randomUUID(),
        timestamp: this.now(),
      });
    } catch {
      // Network error reaching Apple — transient, not the device's fault.
      return 'unavailable';
    }
    if (res.status === 200) {
      const text = await res.text();
      // Apple answers 200 with JSON bits when bits were ever set, and
      // 200 with a plain "Failed to find bit state" message when the
      // device is valid but bits were never written.
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && 'bit0' in parsed) {
          return { claimed: (parsed as { bit0: unknown }).bit0 === true };
        }
      } catch {
        /* non-JSON 200 → no bit state yet */
      }
      return { claimed: false };
    }
    // Distinguish a forged/expired device token (Apple 4xx → TERMINAL)
    // from a transient outage / OUR misconfigured .p8|team|env (5xx, 429,
    // and the 401s those produce → retryable). A 401 is ambiguous (bad
    // token OR bad auth) but treating it as transient is the safe bias:
    // we never permanently brick a real device over a config slip.
    if (res.status >= 500 || res.status === 429 || res.status === 401) {
      return 'unavailable';
    }
    return 'invalid';
  }

  async setClaimed(token: string): Promise<void> {
    const res = await this.post('/v1/update_two_bits', {
      device_token: token,
      transaction_id: randomUUID(),
      timestamp: this.now(),
      bit0: true,
      bit1: false,
    });
    if (res.status !== 200) {
      throw new Error(`devicecheck update_two_bits failed: HTTP ${res.status}`);
    }
  }
}
