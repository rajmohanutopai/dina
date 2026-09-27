/**
 * Owner-only setup client (WEB_OWNER_SURFACE_PLAN §3.5): the devices that act
 * for the owner — coding agents, staff phones, and browsers connected as the
 * owner's device. Sends through an `OwnerDispatcher`, so the same client
 * serves the phone (in-process) and the browser (signed HTTP).
 *
 * The methods mirror the `/v1/owner/setup/*` routes one-to-one. Minting needs
 * a person present (§3.8): a refusal comes back as `no_user_presence`, which
 * the screen answers with the presence prompt and a retry.
 */

import { OWNER_SETUP_PREFIX } from '../server/routes/owner_setup';

import type { OwnerDispatcher } from './owner-dispatch';
import type { CoreResponse } from '../server/router';

export { OWNER_SETUP_PREFIX };

export interface OwnerSetupDevice {
  device_id: string;
  did: string;
  name: string;
  created_at: number;
  last_seen: number;
}

/** Any device the node has paired, revoked ones included (the Agents list). */
export interface OwnerSetupDeviceEntry extends OwnerSetupDevice {
  role: string;
  scope?: string;
  revoked: boolean;
}

/** The server's approval phone (a server node only; the phone is its own). */
export interface ApprovalPhoneStatus {
  configured: boolean;
  state: string;
  phoneDid?: string;
  deviceDid?: string;
}

export type AgentSupervisionProfile =
  | 'network_protection'
  | 'sensitive_boundaries'
  | 'full_supervision';

export interface AgentSupervisionPolicy {
  agent_did: string;
  profile: AgentSupervisionProfile;
  policy_version: number;
  revoked_at: number | null;
  owner_binding_status: 'active' | 'stale_owner_binding';
}

export interface AgentSupervisionPolicies {
  policies: AgentSupervisionPolicy[];
  /** Policies an earlier owner identity chose: full supervision applies until reconfirmed. */
  stale_policies: AgentSupervisionPolicy[];
}

export interface OwnerSetupStatus {
  coding_agent_pairing_available: boolean;
  home_did: string | null;
  msgbox_url: string;
  coding_agents: OwnerSetupDevice[];
  staff_devices: OwnerSetupDevice[];
  owner_devices: OwnerSetupDevice[];
  devices: OwnerSetupDeviceEntry[];
  /** Present on a server node, which can pair a phone to approve its cards. */
  phone?: ApprovalPhoneStatus;
}

export interface MintedSetupCode {
  setup_code: string;
  expires_at: number;
  device_name?: string;
}

export interface MintedOwnerDeviceCode {
  code: string;
  device_name: string;
  expires_at: number;
}

export class OwnerSetupHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The route's error key (`no_user_presence`, `staff_device_not_found`, …). */
    readonly errorKey: string,
  ) {
    super(message);
    this.name = 'OwnerSetupHttpError';
  }
}

function expectStatus<T>(res: CoreResponse, ok: number, ctx: string): T {
  if (res.status !== ok) {
    const key = (res.body as { error?: string } | undefined)?.error ?? 'error';
    throw new OwnerSetupHttpError(
      `OwnerSetupClient: ${ctx} failed ${String(res.status)} — ${key}`,
      res.status,
      key,
    );
  }
  return res.body as T;
}

export class OwnerSetupClient {
  constructor(private readonly dispatcher: OwnerDispatcher) {}

  async status(): Promise<OwnerSetupStatus> {
    const res = await this.dispatcher.dispatch({
      method: 'GET',
      path: `${OWNER_SETUP_PREFIX}/status`,
    });
    return expectStatus<OwnerSetupStatus>(res, 200, 'status');
  }

  /** A coding agent's setup code; the node names it `coding-agent` when no name is given. */
  async mintCodingAgentCode(deviceName?: string): Promise<MintedSetupCode> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: `${OWNER_SETUP_PREFIX}/coding-agent`,
      body: deviceName === undefined ? {} : { device_name: deviceName },
    });
    return expectStatus<MintedSetupCode>(res, 201, 'mintCodingAgentCode');
  }

  async mintStaffCode(deviceName: string): Promise<MintedSetupCode> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: `${OWNER_SETUP_PREFIX}/staff`,
      body: { device_name: deviceName },
    });
    return expectStatus<MintedSetupCode>(res, 201, 'mintStaffCode');
  }

  async mintOwnerDeviceCode(deviceName: string): Promise<MintedOwnerDeviceCode> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: `${OWNER_SETUP_PREFIX}/owner-device`,
      body: { device_name: deviceName },
    });
    return expectStatus<MintedOwnerDeviceCode>(res, 201, 'mintOwnerDeviceCode');
  }

  async revokeCodingAgent(deviceId: string): Promise<void> {
    await this.revoke('coding-agent', deviceId);
  }

  async revokeStaffDevice(deviceId: string): Promise<void> {
    await this.revoke('staff', deviceId);
  }

  async revokeOwnerDevice(deviceId: string): Promise<void> {
    await this.revoke('owner-device', deviceId);
  }

  /** Revoke any paired device, whatever its role. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.revoke('device', deviceId);
  }

  /** Each coding agent's supervision level (`/v1/owner/agent-policies`). */
  async agentPolicies(): Promise<AgentSupervisionPolicies> {
    const res = await this.dispatcher.dispatch({ method: 'GET', path: '/v1/owner/agent-policies' });
    return expectStatus<AgentSupervisionPolicies>(res, 200, 'agentPolicies');
  }

  /**
   * Set a coding agent's supervision level. `expectedVersion` is the version
   * the owner saw (null for the first choice); a stale one is refused. Anything
   * below full supervision needs a person present.
   */
  async setAgentPolicy(
    agentDid: string,
    profile: AgentSupervisionProfile,
    expectedVersion: number | null,
  ): Promise<AgentSupervisionPolicy> {
    const res = await this.dispatcher.dispatch({
      method: 'PUT',
      path: `/v1/owner/agent-policies/${encodeURIComponent(agentDid)}`,
      body: { profile, expected_version: expectedVersion },
    });
    return expectStatus<AgentSupervisionPolicy>(
      res,
      expectedVersion === null ? 201 : 200,
      'setAgentPolicy',
    );
  }

  /** Pair the phone that approves this server node's cards. */
  async pairApprovalPhone(setupCode: string): Promise<ApprovalPhoneStatus> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: `${OWNER_SETUP_PREFIX}/phone`,
      body: { setup_code: setupCode },
    });
    return expectStatus<{ phone: ApprovalPhoneStatus }>(res, 200, 'pairApprovalPhone').phone;
  }

  /** Unpair it. `revoking` means the relay still owes the remote cleanup. */
  async revokeApprovalPhone(): Promise<ApprovalPhoneStatus> {
    const res = await this.dispatcher.dispatch({
      method: 'DELETE',
      path: `${OWNER_SETUP_PREFIX}/phone`,
    });
    const ok = res.status === 202 ? 202 : 200;
    return expectStatus<{ phone: ApprovalPhoneStatus }>(res, ok, 'revokeApprovalPhone').phone;
  }

  private async revoke(
    kind: 'coding-agent' | 'staff' | 'owner-device' | 'device',
    deviceId: string,
  ): Promise<void> {
    const res = await this.dispatcher.dispatch({
      method: 'DELETE',
      path: `${OWNER_SETUP_PREFIX}/${kind}/${encodeURIComponent(deviceId)}`,
    });
    expectStatus<unknown>(res, 204, `revoke ${kind}`);
  }
}
