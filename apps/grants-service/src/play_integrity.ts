/**
 * Google Play Integrity adapter — the real Android `DeviceState`.
 *
 * The Android analog of the DeviceCheck client. Two Google endpoints,
 * one OAuth scheme (a service-account access token from google_oauth):
 *
 *   POST v1/{package}:decodeIntegrityToken  — decode + verify a token
 *                                             the device produced; the
 *                                             verdict says whether it is
 *                                             a genuine device, and the
 *                                             DEVICE RECALL bits say
 *                                             whether it already claimed.
 *   POST v1/{package}:writeDeviceRecall      — set recall bit0 = claimed.
 *
 * Why Device Recall (not our own device ledger): it is the Android
 * primitive that matches DeviceCheck bits — a few per-device bits Google
 * stores that survive reinstall, so "one free grant per physical device"
 * holds without us keeping any device identity. `check` reads the bit
 * out of the decoded token; `setClaimed` writes it. Same "zero device
 * ledger on our side" posture as iOS.
 *
 * Three outcomes from `check`, never a throw (mirrors DeviceState):
 *   - 'invalid'     — a forged/replayed/emulator token (bad package,
 *                     stale timestamp, or a device-integrity verdict that
 *                     does not meet the bar) → TERMINAL refusal.
 *   - 'unavailable' — a transient Google outage / OUR misconfig (auth
 *                     failure, 5xx, network) → the device retries later.
 *   - { claimed }   — a genuine device; claimed = recall bit0.
 *
 * Wire shapes below follow the documented Play Integrity REST v1 JSON
 * (proto3 camelCase). They are exercised end to end only against a live
 * project on a real device; the fields read here are the load-bearing
 * ones and are pinned by the adapter tests via the injected fetch.
 *
 * Privacy: integrity tokens are request-scoped and never logged.
 */

import type { DeviceState } from './ports';

const PLAY_INTEGRITY_BASE = 'https://playintegrity.googleapis.com/v1';

/** Device-integrity labels Play Integrity may return, strongest first. */
export type DeviceVerdict = 'MEETS_STRONG_INTEGRITY' | 'MEETS_DEVICE_INTEGRITY' | 'MEETS_BASIC_INTEGRITY';

export interface PlayIntegrityOptions {
  /** The app's package name, e.g. com.dinakernel.mobile. */
  packageName: string;
  /** Mints service-account OAuth tokens for the playintegrity scope. */
  tokenMinter: { getAccessToken(): Promise<string> };
  /**
   * Reject a token whose device verdict does not include this label.
   * Default MEETS_DEVICE_INTEGRITY — genuine, uncompromised device; an
   * emulator or rooted phone reports only MEETS_BASIC_INTEGRITY or an
   * empty verdict and is refused. Raise to STRONG for hardware-backed.
   */
  minDeviceVerdict?: DeviceVerdict;
  /** Reject a token older than this (replay/staleness). Default 10 min. */
  maxTokenAgeMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface DecodedPayload {
  requestDetails?: { requestPackageName?: unknown; timestampMillis?: unknown };
  appIntegrity?: { appRecognitionVerdict?: unknown; packageName?: unknown };
  deviceIntegrity?: { deviceRecognitionVerdict?: unknown };
  deviceRecall?: { values?: { bitFirst?: unknown } };
}

const VERDICT_RANK: Record<DeviceVerdict, number> = {
  MEETS_BASIC_INTEGRITY: 1,
  MEETS_DEVICE_INTEGRITY: 2,
  MEETS_STRONG_INTEGRITY: 3,
};

/**
 * Does the token's device verdict meet the required bar? The verdict is
 * an array of labels; a device meets a bar if it carries any label at or
 * above it. An empty/absent verdict (emulator, failed integrity) meets
 * nothing.
 */
export function meetsDeviceBar(verdict: unknown, bar: DeviceVerdict): boolean {
  if (!Array.isArray(verdict)) return false;
  const need = VERDICT_RANK[bar];
  return verdict.some((v) => {
    const rank = typeof v === 'string' ? VERDICT_RANK[v as DeviceVerdict] : undefined;
    return rank !== undefined && rank >= need;
  });
}

export class PlayIntegrityClient implements DeviceState {
  private readonly opts: PlayIntegrityOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly minVerdict: DeviceVerdict;
  private readonly maxAgeMs: number;

  constructor(opts: PlayIntegrityOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.minVerdict = opts.minDeviceVerdict ?? 'MEETS_DEVICE_INTEGRITY';
    this.maxAgeMs = opts.maxTokenAgeMs ?? 10 * 60 * 1000;
  }

  private async authedPost(
    action: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const accessToken = await this.opts.tokenMinter.getAccessToken();
    const url = `${PLAY_INTEGRITY_BASE}/${encodeURIComponent(this.opts.packageName)}:${action}`;
    return this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async check(token: string): Promise<'invalid' | 'unavailable' | { claimed: boolean }> {
    let res: Response;
    try {
      res = await this.authedPost('decodeIntegrityToken', { integrityToken: token });
    } catch {
      // Could not reach Google OR mint an access token — transient, not
      // the device's fault.
      return 'unavailable';
    }
    if (res.status !== 200) {
      // 401/403 (bad service-account/scope) and 5xx/429 are OUR problem
      // or a transient outage → retryable. A 400 is a malformed token →
      // the device's token is bad → terminal invalid. Safe bias matches
      // DeviceCheck: never brick a real device over our config slip.
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
        return 'unavailable';
      }
      return 'invalid';
    }

    let payload: DecodedPayload;
    try {
      const parsed = (await res.json()) as { tokenPayloadExternal?: DecodedPayload };
      if (parsed.tokenPayloadExternal === undefined) return 'invalid';
      payload = parsed.tokenPayloadExternal;
    } catch {
      return 'unavailable'; // a 200 we could not parse is not the device's fault
    }

    // Package binding: the token must have been minted for OUR app.
    const reqPkg = payload.requestDetails?.requestPackageName;
    if (reqPkg !== this.opts.packageName) return 'invalid';

    // Freshness: reject a stale (replayed) token. Google stamps
    // timestampMillis as a string of epoch ms.
    const tsRaw = payload.requestDetails?.timestampMillis;
    const ts = typeof tsRaw === 'string' ? Number(tsRaw) : typeof tsRaw === 'number' ? tsRaw : NaN;
    if (!Number.isFinite(ts) || this.now() - ts > this.maxAgeMs || ts - this.now() > this.maxAgeMs) {
      return 'invalid';
    }

    // Device integrity: a genuine device meets the bar; an emulator does
    // not. This is the anti-farm gate that lets us hand out free credits.
    if (!meetsDeviceBar(payload.deviceIntegrity?.deviceRecognitionVerdict, this.minVerdict)) {
      return 'invalid';
    }

    // Device Recall bit0 = already claimed on this physical device.
    const claimed = payload.deviceRecall?.values?.bitFirst === true;
    return { claimed };
  }

  async setClaimed(token: string): Promise<void> {
    const res = await this.authedPost('writeDeviceRecall', {
      integrityToken: token,
      newValues: { bitFirst: true },
    });
    if (res.status !== 200) {
      throw new Error(`play integrity writeDeviceRecall failed: HTTP ${res.status}`);
    }
  }
}
