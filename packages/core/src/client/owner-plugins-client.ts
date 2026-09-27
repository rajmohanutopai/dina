/**
 * The owner's plugins (WEB_OWNER_SURFACE_PLAN §3.5): install, consent,
 * runner pairing, uninstall, and the updates Dina's own packs take with the
 * build. Sends through an `OwnerDispatcher`, so one client serves the phone
 * (in-process) and a browser connected as the owner (signed HTTP), and the
 * §3.8 presence checks on consent, runner pairing and updates apply to both.
 *
 * The methods mirror the `/v1/plugins/*` and `/v1/commerce/install/*` routes.
 * An answer a caller must act on (a transient begin failure, a teardown that
 * kept its row, a coordinator's refusal) comes back as data; anything else
 * raises `OwnerPluginsHttpError` carrying Core's error key.
 */

import type { OwnerDispatcher, OwnerRequest } from './owner-dispatch';
import type { FirstPartyConfirmResult } from '../commerce/pack_update';
import type { BeginInstallResult } from '../plugins/install_service';
import type { RunnerPairingState } from '../plugins/runner_pairing';
import type { PrepareUpdateResult } from '../plugins/update_service';
import type { WideningFinding } from '../plugins/update_widening';
import type { CoreResponse } from '../server/router';

export class OwnerPluginsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Core's error key (`no_user_presence`, `runner_not_paired`, …). */
    readonly errorKey: string,
  ) {
    super(message);
    this.name = 'OwnerPluginsHttpError';
  }
}

export interface PluginInstallRow {
  install_id: string;
  plugin_id: string;
  status: string;
  execution_mode: 'interpreted' | 'runner';
}

export interface PluginInstallsView {
  installs: PluginInstallRow[];
  /** False when the node has no plugin registry wired. */
  registry_available: boolean;
  /** False when this build cannot verify a third-party release at all. */
  third_party_available: boolean;
}

/** A country pack already granted answers with its install, not a new consent. */
export type CountryPackBegin =
  | BeginInstallResult
  | { ok: true; installId: string; status: 'active' };

export interface RunnerCode {
  code: string;
  /** Unix seconds. */
  expires_at: number;
  /** The one-paste `dina1:` string, when the node names its relay. */
  setup_code?: string;
}

export type TeardownAnswer =
  | { ok: true }
  | {
      ok: false;
      error: 'install_unknown' | 'install_not_pending' | 'obligations_open' | 'teardown_incomplete';
      detail?: string;
    };

export interface PackUpdateRow {
  install_id: string;
  plugin_id: string;
  display_name: string;
  from_version: string;
  to_version: string;
}

export interface CommercePackBegin {
  ok: true;
  install_id: string;
  plugin_id: string;
  status: 'active' | 'pending';
}

function keyOf(res: CoreResponse): string {
  const body = res.body as { error?: unknown; code?: unknown } | undefined;
  if (typeof body?.error === 'string') return body.error;
  if (typeof body?.code === 'string') return body.code;
  return 'error';
}

/** A begin answer carries `ok`; a route's own refusal (`{error}`) does not. */
function isResult(res: CoreResponse): boolean {
  return (
    (res.status === 200 || res.status === 409 || res.status === 503) &&
    typeof (res.body as { ok?: unknown } | undefined)?.ok === 'boolean'
  );
}

function refused(res: CoreResponse, ctx: string): OwnerPluginsHttpError {
  const key = keyOf(res);
  return new OwnerPluginsHttpError(
    `OwnerPluginsClient: ${ctx} failed ${String(res.status)} — ${key}`,
    res.status,
    key,
  );
}

export class OwnerPluginsClient {
  constructor(private readonly dispatcher: OwnerDispatcher) {}

  private send(req: OwnerRequest): Promise<CoreResponse> {
    return this.dispatcher.dispatch(req);
  }

  async installs(): Promise<PluginInstallsView> {
    const res = await this.send({ method: 'GET', path: '/v1/plugins/installs' });
    if (res.status !== 200) throw refused(res, 'installs');
    return res.body as PluginInstallsView;
  }

  /** Fetch, authenticate (repo proof) and stage a third-party release. */
  async begin(publisherDid: string, rkey: string, label?: string): Promise<BeginInstallResult> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/plugins/install/begin',
      body: {
        publisher_did: publisherDid,
        rkey,
        ...(label !== undefined && label !== '' ? { label } : {}),
      },
    });
    // 200 staged; 409 a permanent refusal; 503 try again — each is an answer.
    if (isResult(res)) return res.body as BeginInstallResult;
    throw refused(res, 'begin');
  }

  /** Stage a country pack through the first-party door. */
  async beginCountryPack(pack: string): Promise<CountryPackBegin> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/plugins/install/country_pack',
      body: { pack },
    });
    if (isResult(res)) return res.body as CountryPackBegin;
    throw refused(res, 'beginCountryPack');
  }

  /** The runner's pairing code for a pending install (needs a person present). */
  async runnerCode(installId: string): Promise<RunnerCode> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/plugins/install/setup_code',
      body: { install_id: installId },
    });
    if (res.status !== 201) throw refused(res, 'runnerCode');
    return res.body as RunnerCode;
  }

  /** Where the runner ceremony stands. Read-only. */
  async pairingState(installId: string, code: string): Promise<RunnerPairingState> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/plugins/install/pairing_state',
      body: { install_id: installId, code },
    });
    if (res.status !== 200) throw refused(res, 'pairingState');
    return res.body as RunnerPairingState;
  }

  /** Consent: activate on the device Core bound (needs a person present). */
  async confirm(installId: string): Promise<void> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/plugins/install/confirm',
      body: { install_id: installId },
    });
    if (res.status !== 200) throw refused(res, 'confirm');
  }

  async decline(installId: string): Promise<TeardownAnswer> {
    return this.teardown('/v1/plugins/install/decline', installId, 'decline');
  }

  async uninstall(installId: string): Promise<TeardownAnswer> {
    return this.teardown('/v1/plugins/install/uninstall', installId, 'uninstall');
  }

  private async teardown(path: string, installId: string, ctx: string): Promise<TeardownAnswer> {
    const res = await this.send({ method: 'POST', path, body: { install_id: installId } });
    if (res.status === 200) return { ok: true };
    const key = keyOf(res);
    if (
      key === 'install_unknown' ||
      key === 'install_not_pending' ||
      key === 'obligations_open' ||
      key === 'teardown_incomplete'
    ) {
      const detail = (res.body as { detail?: unknown } | undefined)?.detail;
      return { ok: false, error: key, ...(typeof detail === 'string' ? { detail } : {}) };
    }
    throw refused(res, ctx);
  }

  /** Updates Dina's own packs take with this build. */
  async packUpdates(): Promise<PackUpdateRow[]> {
    const res = await this.send({ method: 'GET', path: '/v1/commerce/install/updates' });
    if (res.status !== 200) throw refused(res, 'packUpdates');
    return (res.body as { updates?: PackUpdateRow[] }).updates ?? [];
  }

  /** Review one; nothing is applied by looking. */
  async preparePackUpdate(installId: string): Promise<PrepareUpdateResult> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/commerce/install/update/prepare',
      body: { install_id: installId },
    });
    if (res.status === 200 || res.status === 404 || res.status === 409 || res.status === 503) {
      return res.body as PrepareUpdateResult;
    }
    throw refused(res, 'preparePackUpdate');
  }

  /** Apply the reviewed update (needs a person present). */
  async confirmPackUpdate(args: {
    installId: string;
    toCid: string;
    acceptedWidening: readonly WideningFinding[];
    acceptedBehaviorHash: string;
  }): Promise<FirstPartyConfirmResult> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/commerce/install/update/confirm',
      body: {
        install_id: args.installId,
        to_cid: args.toCid,
        accepted_widening: args.acceptedWidening,
        accepted_behavior_hash: args.acceptedBehaviorHash,
      },
    });
    // 200 applied; 404/409 a refusal the result names. A presence refusal and
    // anything else is an error.
    if (
      (res.status === 200 || res.status === 404 || res.status === 409) &&
      keyOf(res) !== 'no_user_presence'
    ) {
      return res.body as FirstPartyConfirmResult;
    }
    throw refused(res, 'confirmPackUpdate');
  }

  /** Begin a first-party commerce pack; an active one answers as such. */
  async beginCommercePack(role: 'buyer' | 'supplier'): Promise<CommercePackBegin> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/commerce/install/begin',
      body: { role },
    });
    if (res.status !== 200) throw refused(res, 'beginCommercePack');
    return res.body as CommercePackBegin;
  }

  /** Core mints and binds the pack's first-party runner (needs a person present). */
  async bindReferenceRunner(installId: string): Promise<{ device_did: string }> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/commerce/install/bind_reference_runner',
      body: { install_id: installId },
    });
    if (res.status !== 200) throw refused(res, 'bindReferenceRunner');
    return res.body as { device_did: string };
  }

  /** Consent to the pack on the bound runner (needs a person present). */
  async confirmCommercePack(installId: string, deviceDid: string): Promise<void> {
    const res = await this.send({
      method: 'POST',
      path: '/v1/commerce/install/confirm',
      body: { install_id: installId, device_did: deviceDid },
    });
    if (res.status !== 200) throw refused(res, 'confirmCommercePack');
  }
}
