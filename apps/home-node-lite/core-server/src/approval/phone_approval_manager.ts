import { deriveServiceKey } from '@dina/core';
import { kvDelete, kvGet, kvSet } from '@dina/core/kv';

import { PhoneApprovalMsgBoxClient, parsePhoneSetupCode } from './phone_approval_msgbox';
import { PhoneApprovalSyncWorker, withdrawAllPhoneApprovalMirrors } from './phone_approval_sync';

const TARGET_NAMESPACE = 'phone_approval_sync';
const TARGET_KEY = 'target';

interface PhoneTarget {
  v: 2;
  msgbox_url: string;
  phone_did: string;
  state: 'pairing' | 'active' | 'revoking';
}

export interface PhoneApprovalStatus {
  configured: boolean;
  state: 'unpaired' | 'active' | 'revoking';
  phoneDid?: string;
  deviceDid?: string;
}

export interface PhoneApprovalLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Owns the laptop Core -> phone approval child device lifecycle.
 *
 * The child key is deterministically derived from the laptop seed and never
 * crosses the owner API. Pairing codes are consumed in memory and never
 * persisted. Revocation is durable-first: a failed remote revoke leaves a
 * `revoking` tombstone and no worker, then retries on the next boot.
 */
export class PhoneApprovalManager {
  private client: PhoneApprovalMsgBoxClient | null = null;
  private worker: PhoneApprovalSyncWorker | null = null;
  private target: PhoneTarget | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly seed: Uint8Array,
    private readonly logger: PhoneApprovalLogger,
  ) {}

  async initialize(setupCode?: string): Promise<void> {
    await this.serial(async () => {
      const persisted = await kvGet(TARGET_KEY, TARGET_NAMESPACE);
      this.target = parseTarget(persisted);

      if (this.target?.state === 'revoking' || this.target?.state === 'pairing') {
        await this.tryFinishRevoke();
      } else if (this.target?.state === 'active') {
        this.activate(this.target);
      }

      if (this.target === null && setupCode?.trim()) {
        await this.pairInternal(setupCode);
      }
    });
  }

  status(): PhoneApprovalStatus {
    if (this.target === null) return { configured: false, state: 'unpaired' };
    return {
      configured: this.target.state === 'active',
      state: this.target.state === 'active' ? 'active' : 'revoking',
      phoneDid: this.target.phone_did,
      deviceDid: this.makeClient(this.target).did,
    };
  }

  async pair(setupCode: string): Promise<PhoneApprovalStatus> {
    await this.serial(() => this.pairInternal(setupCode));
    return this.status();
  }

  async revoke(): Promise<PhoneApprovalStatus> {
    await this.serial(async () => {
      if (this.target === null) return;
      await this.worker?.stop();
      this.worker = null;

      this.target = { ...this.target, state: 'revoking' };
      await persistTarget(this.target);
      await this.tryFinishRevoke();
    });
    return this.status();
  }

  async stop(): Promise<void> {
    await this.serial(async () => {
      await this.worker?.stop();
      this.worker = null;
      this.client = null;
    });
  }

  private async pairInternal(raw: string): Promise<void> {
    const setup = parsePhoneSetupCode(raw.trim());
    if (this.target?.state === 'active') {
      throw new Error('an approval phone is already paired; revoke it before pairing another');
    }
    if (this.target?.state === 'revoking' || this.target?.state === 'pairing') {
      await this.tryFinishRevoke();
      if (this.target !== null) {
        throw new Error(
          'the previous phone revocation is still pending; retry when it is reachable',
        );
      }
    }

    // Persist a public, non-authorizing cleanup marker before crossing the
    // network. If the process dies after the phone accepts the child device
    // but before the active target commits, restart revokes that deterministic
    // child instead of leaving an owner-approval device orphaned.
    const pairingTarget: PhoneTarget = {
      v: 2,
      msgbox_url: setup.msgboxURL,
      phone_did: setup.phoneDID,
      state: 'pairing',
    };
    await persistTarget(pairingTarget);
    this.target = pairingTarget;
    const client = this.makeClient(pairingTarget);
    try {
      await client.pair(setup.code, setup.deviceName);
    } catch (err) {
      await this.tryFinishRevoke();
      throw err;
    }
    const target: PhoneTarget = { ...pairingTarget, state: 'active' };
    // Persist active before starting the worker. If this write fails, the
    // durable pairing marker remains and restart performs cleanup.
    await persistTarget(target);
    this.target = target;
    this.client = client;
    this.startWorker(client);
    this.logger.info(
      { phoneDid: target.phone_did, deviceDid: client.did },
      'owner-phone approval synchronization enabled',
    );
  }

  private activate(target: PhoneTarget): void {
    const client = this.makeClient(target);
    this.client = client;
    this.startWorker(client);
    this.logger.info(
      { phoneDid: target.phone_did, deviceDid: client.did },
      'owner-phone approval synchronization restored',
    );
  }

  private startWorker(client: PhoneApprovalMsgBoxClient): void {
    const worker = new PhoneApprovalSyncWorker(client);
    this.worker = worker;
    worker.start();
  }

  private async tryFinishRevoke(): Promise<void> {
    if (this.target?.state !== 'revoking' && this.target?.state !== 'pairing') return;
    const target = this.target;
    const client = this.makeClient(target);
    try {
      if (target.state === 'revoking') {
        const mirrors = await withdrawAllPhoneApprovalMirrors(client);
        if (mirrors.failed > 0) {
          throw new Error('phone mirror withdrawal is still pending');
        }
      }
      const response = await client.request('DELETE', '/v1/devices/self');
      const absentBeforePair =
        target.state === 'pairing' && (response.status === 401 || response.status === 403);
      if (
        (response.status < 200 || response.status >= 300) &&
        response.status !== 404 &&
        !absentBeforePair
      ) {
        throw new Error(`phone device revoke failed (${response.status})`);
      }
      await kvDelete(TARGET_KEY, TARGET_NAMESPACE);
      this.target = null;
      this.client = null;
      this.logger.info(
        { phoneDid: target.phone_did, deviceDid: client.did },
        'owner-phone approval synchronization revoked',
      );
    } catch (err) {
      this.logger.warn(
        {
          phoneDid: target.phone_did,
          error: err instanceof Error ? err.message : String(err),
        },
        'owner-phone revoke remains pending; approval synchronization stays disabled',
      );
    }
  }

  private makeClient(target: Pick<PhoneTarget, 'msgbox_url' | 'phone_did'>) {
    const approvalKey = deriveServiceKey(this.seed, 2);
    return new PhoneApprovalMsgBoxClient({
      msgboxURL: target.msgbox_url,
      phoneDID: target.phone_did,
      privateKey: approvalKey.privateKey,
    });
  }

  private async serial(fn: () => Promise<void>): Promise<void> {
    const next = this.operation.then(fn, fn);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

function parseTarget(raw: string | null): PhoneTarget | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.msgbox_url !== 'string' ||
      (!value.msgbox_url.startsWith('ws://') && !value.msgbox_url.startsWith('wss://')) ||
      typeof value.phone_did !== 'string' ||
      !value.phone_did.startsWith('did:')
    ) {
      return null;
    }
    const state =
      value.state === undefined || value.state === 'active'
        ? 'active'
        : value.state === 'revoking' || value.state === 'pairing'
          ? value.state
          : null;
    if (state === null) return null;
    return {
      v: 2,
      msgbox_url: value.msgbox_url,
      phone_did: value.phone_did,
      state,
    };
  } catch {
    return null;
  }
}

async function persistTarget(target: PhoneTarget): Promise<void> {
  await kvSet(TARGET_KEY, JSON.stringify(target), TARGET_NAMESPACE);
}
