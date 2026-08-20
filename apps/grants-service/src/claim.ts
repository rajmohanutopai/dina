/**
 * The claim pipeline — pure orchestration over the ports.
 *
 * Order (docs/CREDITS_DESIGN.md §claim pipeline, with the failure-order
 * tradeoff made explicit):
 *
 *   parse → platform enabled? → paused / global daily ceiling? →
 *   attestation check (validity + claimed-state, one call) →
 *   PROVISION KEY → set claimed bit → ledger → respond.
 *
 * Why provision BEFORE setting the bit: if we set the bit first and
 * provisioning then fails, the device has burned its once-only claim
 * and received nothing — unrecoverable bad faith with a brand-new
 * user. The reverse failure (key delivered, bit-set fails) risks a
 * bounded double-grant (another ~$0.25), which we accept and log
 * loudly. Generosity-side failure is the right side to fail on.
 *
 * Privacy: this module never sees a DID, never logs the attestation
 * token or the minted key. The only request-derived value that may be
 * logged is `platform` + the refusal code.
 */

import { randomUUID } from 'node:crypto';

import { parseClaimGrantRequest } from '@dina/protocol';

import type { GrantsConfig } from './config';
import type { DeviceState, GrantLedger, KeyProvisioner } from './ports';
import type { ClaimGrantResponse, ClaimRefusalCode, CreditsPlatform } from '@dina/protocol';

export interface ClaimDeps {
  config: GrantsConfig;
  /**
   * The attestation backend per platform: iOS → DeviceCheck, Android →
   * Play Integrity. A platform with no entry is treated as a transient
   * outage (should not happen once its `enabled*` flag is on — a missing
   * wire is our misconfig, never the device's fault).
   */
  deviceStates: Partial<Record<CreditsPlatform, DeviceState>>;
  provisioner: KeyProvisioner;
  ledger: GrantLedger;
  /** Injectable clock (ms). */
  now?: () => number;
  /** Structured, content-free logging hooks. */
  log?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export type ClaimOutcome =
  | { status: 200; body: ClaimGrantResponse }
  | { status: 400 | 403 | 409 | 429 | 503; body: { error: ClaimRefusalCode } }
  | { status: 400; body: { error: 'bad_request' } }
  | { status: 503; body: { error: 'provisioning_unavailable' } };

const DAY_MS = 24 * 60 * 60 * 1000;

export async function processClaim(deps: ClaimDeps, rawBody: unknown): Promise<ClaimOutcome> {
  const { config, provisioner, ledger } = deps;
  const now = deps.now ?? Date.now;
  const noop = (): void => undefined;
  const log = deps.log ?? { info: noop, warn: noop, error: noop };

  const req = parseClaimGrantRequest(rawBody);
  if (req === null) return { status: 400, body: { error: 'bad_request' } };

  // Platform gating before anything else — each platform is enabled by
  // its own config flag (iOS on; Android on once Play Integrity creds are
  // wired and GRANTS_ENABLED_ANDROID is set).
  const enabled = req.platform === 'ios' ? config.enabledIos : config.enabledAndroid;
  if (!enabled) {
    return { status: 403, body: { error: 'platform_disabled' } };
  }

  if (config.paused) {
    return { status: 503, body: { error: 'grants_paused' } };
  }

  // Global daily ceiling — an automatic pause, not a per-client limit.
  if (config.maxGrantsPerDay > 0) {
    const minted = ledger.countSince(now() - DAY_MS);
    if (minted >= config.maxGrantsPerDay) {
      log.warn('daily grant ceiling reached — refusing as paused', { minted });
      return { status: 503, body: { error: 'grants_paused' } };
    }
  }

  // App Attest is the documented iOS upgrade but is not wired on either
  // platform yet — refuse it cleanly. Ruling it out here also narrows
  // `attestation` to the token-bearing variants (devicecheck /
  // play_integrity) for the deviceState calls below.
  if (req.attestation.kind === 'app_attest') {
    return { status: 403, body: { error: 'attestation_failed' } };
  }
  const { kind, token } = req.attestation;

  // Platform ↔ attestation-kind policy:
  //   iOS               → DeviceCheck (production).
  //   Android (prod)    → Play Integrity.
  //   Android (dev)     → DeviceCheck token under GRANTS_DEV_ALLOW_ANDROID
  //                       (DEV / E2E ONLY) — pairs with the fake stub so
  //                       an emulator can drive a real mint; the flag IS
  //                       the trust decision, not the fake token.
  const attestationOk =
    (req.platform === 'ios' && kind === 'devicecheck') ||
    (req.platform === 'android' && config.devAllowAndroidClaim && kind === 'devicecheck') ||
    (req.platform === 'android' && !config.devAllowAndroidClaim && kind === 'play_integrity');
  if (!attestationOk) {
    return { status: 403, body: { error: 'attestation_failed' } };
  }

  // Resolve the attestation backend for this platform. A missing wire is
  // our misconfig, not the device's fault → transient.
  const deviceState = deps.deviceStates[req.platform];
  if (deviceState === undefined) {
    log.warn('no device-state backend wired for platform — transient refusal', {
      platform: req.platform,
    });
    return { status: 503, body: { error: 'attestation_unavailable' } };
  }

  const state = await deviceState.check(token);
  if (state === 'invalid') {
    return { status: 403, body: { error: 'attestation_failed' } };
  }
  if (state === 'unavailable') {
    // Transient attestation backend trouble — the client retries next
    // launch instead of latching a permanent refusal (review P1).
    log.warn('attestation backend unavailable — transient refusal');
    return { status: 503, body: { error: 'attestation_unavailable' } };
  }
  if (state.claimed) {
    return { status: 409, body: { error: 'already_claimed' } };
  }

  // Provision FIRST (see module docs for the ordering tradeoff).
  const grantId = randomUUID();
  let minted: { key: string; orKeyId: string };
  try {
    minted = await provisioner.createCappedKey({
      limitUsd: config.grantUsd,
      label: `grant-${grantId}`,
    });
  } catch (err) {
    log.error('provisioning failed', { reason: err instanceof Error ? err.name : typeof err });
    return { status: 503, body: { error: 'provisioning_unavailable' } };
  }

  try {
    await deviceState.setClaimed(token);
  } catch (err) {
    // Key already delivered — accept the bounded double-grant risk and
    // make it observable (spec tradeoff: fail on the generous side).
    log.error('set-claimed failed AFTER provisioning — bounded double-grant risk', {
      reason: err instanceof Error ? err.name : typeof err,
    });
  }

  try {
    ledger.insert({
      grantId,
      orKeyId: minted.orKeyId,
      platform: req.platform,
      grantedAt: now(),
    });
  } catch (err) {
    // Ops data only — never block a granted user on ledger trouble.
    log.error('ledger insert failed', { reason: err instanceof Error ? err.name : typeof err });
  }

  log.info('grant minted', { platform: req.platform });
  return {
    status: 200,
    body: { key: minted.key, limit_usd: config.grantUsd, model_pin: config.modelPin },
  };
}
