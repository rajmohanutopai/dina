import { buildAgentSetupCode, setWorkflowService } from '@dina/core';
import { kvGet, kvSet, resetKVStore } from '@dina/core/kv';

const mockPair = jest.fn();
const mockRequest = jest.fn();

jest.mock('../src/approval/phone_approval_msgbox', () => {
  const actual = jest.requireActual('../src/approval/phone_approval_msgbox');
  return {
    ...actual,
    PhoneApprovalMsgBoxClient: jest.fn().mockImplementation(() => ({
      did: 'did:key:approval-child',
      pair: mockPair,
      request: mockRequest,
    })),
  };
});

import { PhoneApprovalManager } from '../src/approval/phone_approval_manager';

const setupCode = buildAgentSetupCode({
  msgboxUrl: 'wss://mailbox.example/ws',
  homenodeDid: 'did:plc:phone-owner',
  code: 'ABCDEFGH',
  deviceName: 'Laptop approvals',
});

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
};

describe('PhoneApprovalManager', () => {
  beforeEach(() => {
    mockPair.mockReset().mockResolvedValue(undefined);
    mockRequest.mockReset().mockResolvedValue({ status: 204, body: {} });
    logger.info.mockReset();
    logger.warn.mockReset();
    resetKVStore();
    setWorkflowService(null);
  });

  afterEach(async () => {
    resetKVStore();
    setWorkflowService(null);
  });

  it('pairs with a one-time code but persists only the public target', async () => {
    const manager = new PhoneApprovalManager(new Uint8Array(32).fill(7), logger);
    const status = await manager.pair(setupCode);

    expect(mockPair).toHaveBeenCalledWith('ABCDEFGH', 'Laptop approvals');
    expect(status).toEqual({
      configured: true,
      state: 'active',
      phoneDid: 'did:plc:phone-owner',
      deviceDid: 'did:key:approval-child',
    });
    const persisted = await kvGet('target', 'phone_approval_sync');
    expect(persisted).toContain('"phone_did":"did:plc:phone-owner"');
    expect(persisted).not.toContain('ABCDEFGH');
    expect(persisted).not.toContain('setup_code');
    await manager.stop();
  });

  it('disables locally and retains a revoking tombstone when the phone is offline', async () => {
    const manager = new PhoneApprovalManager(new Uint8Array(32).fill(8), logger);
    await manager.pair(setupCode);
    mockRequest.mockRejectedValueOnce(new Error('offline'));

    const status = await manager.revoke();

    expect(status).toMatchObject({ configured: false, state: 'revoking' });
    expect(await kvGet('target', 'phone_approval_sync')).toContain('"state":"revoking"');
    await manager.stop();
  });

  it('finishes a pending remote revoke on the next boot', async () => {
    const first = new PhoneApprovalManager(new Uint8Array(32).fill(9), logger);
    await first.pair(setupCode);
    mockRequest.mockRejectedValueOnce(new Error('offline'));
    await first.revoke();
    await first.stop();

    mockRequest.mockResolvedValueOnce({ status: 204, body: {} });
    const restarted = new PhoneApprovalManager(new Uint8Array(32).fill(9), logger);
    await restarted.initialize();

    expect(restarted.status()).toEqual({ configured: false, state: 'unpaired' });
    expect(await kvGet('target', 'phone_approval_sync')).toBeNull();
    await restarted.stop();
  });

  it('withdraws durable mirrors before revoking the approval child device', async () => {
    const manager = new PhoneApprovalManager(new Uint8Array(32).fill(12), logger);
    await manager.pair(setupCode);
    await kvSet(
      'source-task',
      JSON.stringify({
        source_task_id: 'source-task',
        proposal_id: 'remote-approval-mirror',
      }),
      'phone_approval_mirrors',
    );

    await manager.revoke();

    expect(mockRequest.mock.calls).toEqual([
      ['DELETE', '/v1/agent/approval-sync/v1/proposals/remote-approval-mirror'],
      ['DELETE', '/v1/devices/self'],
    ]);
    await manager.stop();
  });

  it('persists cleanup intent before pairing and removes it when pairing fails', async () => {
    const manager = new PhoneApprovalManager(new Uint8Array(32).fill(10), logger);
    mockPair.mockRejectedValueOnce(new Error('pairing code expired'));
    // The device was never paired, so authenticated self-revoke is rejected.
    // For a pre-pair cleanup marker this proves no remote authority exists.
    mockRequest.mockResolvedValueOnce({ status: 403, body: {} });

    await expect(manager.pair(setupCode)).rejects.toThrow('pairing code expired');

    expect(mockRequest).toHaveBeenCalledWith('DELETE', '/v1/devices/self');
    expect(manager.status()).toEqual({ configured: false, state: 'unpaired' });
    expect(await kvGet('target', 'phone_approval_sync')).toBeNull();
    await manager.stop();
  });

  it('retains a cleanup marker when failed pairing cannot confirm remote cleanup', async () => {
    const manager = new PhoneApprovalManager(new Uint8Array(32).fill(11), logger);
    mockPair.mockRejectedValueOnce(new Error('response lost'));
    mockRequest.mockRejectedValueOnce(new Error('phone offline'));

    await expect(manager.pair(setupCode)).rejects.toThrow('response lost');

    expect(manager.status()).toMatchObject({ configured: false, state: 'revoking' });
    expect(await kvGet('target', 'phone_approval_sync')).toContain('"state":"pairing"');
    await manager.stop();
  });
});
