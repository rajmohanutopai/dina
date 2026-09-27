/**
 * The Agents screen (WEB_OWNER_SURFACE_PLAN §3.5, §3.8) on the shared
 * owner-setup client: the list is Core's, a code is Core's (a coding agent is
 * stamped `coding` scope there — pinned in @dina/core's owner_setup_routes
 * test), minting needs a person present, and a revoke says when it did not
 * persist. The same screen runs on the phone (in-process) and in a browser
 * connected as the owner (signed HTTP).
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerSetupHttpError, type OwnerSetupDeviceEntry } from '@dina/core';

import PairedDevicesScreen from '../../app/paired-devices';

jest.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../src/services/confirm_decision', () => ({ confirmDecision: async () => true }));
const mockShowMessage = jest.fn();
jest.mock('../../src/services/show_message', () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
}));
let mockRunClient: unknown = null;
jest.mock('../../src/services/owner_run_client', () => ({
  getOwnerRunClient: () => mockRunClient,
}));
const mockProve = jest.fn(async () => ({ ok: true }));
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => ({ provePresence: mockProve }),
}));

const CLAUDE: OwnerSetupDeviceEntry = {
  device_id: 'dev-claude',
  did: 'did:key:z6MkClaude',
  name: 'Laptop Claude',
  created_at: 1_700_000_000_000,
  last_seen: 0,
  role: 'agent',
  scope: 'coding',
  revoked: false,
};
const OLD_CLI: OwnerSetupDeviceEntry = {
  ...CLAUDE,
  device_id: 'dev-cli',
  name: 'Old CLI',
  role: 'cli',
  revoked: true,
};

const mockClient = {
  status: jest.fn(),
  mintCodingAgentCode: jest.fn(),
  mintStaffCode: jest.fn(),
  revokeDevice: jest.fn(),
  agentPolicies: jest.fn(),
  setAgentPolicy: jest.fn(),
  pairApprovalPhone: jest.fn(),
  revokeApprovalPhone: jest.fn(),
};
jest.mock('../../src/services/owner_setup_client', () => ({
  getOwnerSetupClient: () => mockClient,
}));

const presenceRefusal = () => new OwnerSetupHttpError('403', 403, 'no_user_presence');

beforeEach(() => {
  jest.clearAllMocks();
  mockRunClient = null;
  mockClient.status.mockResolvedValue({ devices: [CLAUDE, OLD_CLI] });
  mockClient.mintCodingAgentCode.mockResolvedValue({
    setup_code: 'dina1:agent-setup',
    device_name: 'my-agent',
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  mockClient.mintStaffCode.mockResolvedValue({
    setup_code: 'dina1:staff-setup',
    device_name: 'Till',
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  mockClient.revokeDevice.mockResolvedValue(undefined);
  mockClient.agentPolicies.mockResolvedValue({ policies: [], stale_policies: [] });
  mockClient.setAgentPolicy.mockResolvedValue({});
});

it('lists every device Core knows, revoked ones marked, with a revoke only for the live ones', async () => {
  const screen = render(<PairedDevicesScreen />);
  await waitFor(() => expect(screen.getByText('Laptop Claude')).toBeTruthy());
  expect(screen.getByText('CONNECTED (2)')).toBeTruthy();
  expect(screen.getByText('Old CLI')).toBeTruthy();
  expect(screen.getAllByTestId('paired-devices-revoke')).toHaveLength(1);
});

it('a browser not connected as the owner is told to connect, not shown an empty list', async () => {
  mockClient.status.mockRejectedValue(
    new OwnerSetupHttpError('401', 401, 'owner_device_not_connected'),
  );
  const screen = render(<PairedDevicesScreen />);
  await waitFor(() =>
    expect(String(screen.getByTestId('paired-devices-empty').props.children)).toMatch(
      /Connect this browser as the owner/,
    ),
  );
});

it('turning Brain access on asks for presence first, then registers the agent', async () => {
  const register = jest
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('403'), { errorKey: 'no_user_presence' }))
    .mockResolvedValue({});
  mockRunClient = {
    reasoningBackends: jest.fn(async () => ({ backends: [] })),
    reasoningRegisterBackend: register,
    reasoningRevokeBackend: jest.fn(),
  };
  const screen = render(<PairedDevicesScreen />);
  await waitFor(() => expect(screen.getByText('Laptop Claude')).toBeTruthy());
  fireEvent.press(screen.getByTestId('paired-devices-brain-dev-claude'));
  await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
  expect(register).toHaveBeenCalledTimes(1);
  fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
  fireEvent.press(screen.getByTestId('presence-submit'));
  await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
  expect(mockProve).toHaveBeenCalledWith('correct horse');
  expect(mockShowMessage).not.toHaveBeenCalled();
});

it('a coding agent’s code is Core’s, under the owner’s name', async () => {
  const screen = render(<PairedDevicesScreen />);
  fireEvent.changeText(screen.getByTestId('paired-devices-agent-name'), ' my-agent ');
  fireEvent.press(screen.getByTestId('paired-devices-generate'));
  await waitFor(() => expect(screen.getByTestId('paired-devices-setup-code')).toBeTruthy());
  expect(mockClient.mintCodingAgentCode).toHaveBeenCalledWith('my-agent');
  expect(mockClient.mintStaffCode).not.toHaveBeenCalled();
  expect(screen.getByTestId('paired-devices-setup-code').props.children).toBe('dina1:agent-setup');
});

it('a staff phone’s code comes from the staff route', async () => {
  const screen = render(<PairedDevicesScreen />);
  fireEvent.changeText(screen.getByTestId('paired-devices-agent-name'), 'Till');
  fireEvent.press(screen.getByTestId('paired-devices-role-staff'));
  fireEvent.press(screen.getByTestId('paired-devices-generate'));
  await waitFor(() => expect(mockClient.mintStaffCode).toHaveBeenCalledWith('Till'));
  expect(mockClient.mintCodingAgentCode).not.toHaveBeenCalled();
});

it('no name, no code', async () => {
  const screen = render(<PairedDevicesScreen />);
  fireEvent.press(screen.getByTestId('paired-devices-generate'));
  expect(mockShowMessage).toHaveBeenCalledWith('Device name required', expect.any(String));
  expect(mockClient.mintCodingAgentCode).not.toHaveBeenCalled();
});

it('minting needs a person present: the sheet asks, then the same mint runs again', async () => {
  mockClient.mintCodingAgentCode.mockRejectedValueOnce(presenceRefusal());
  const screen = render(<PairedDevicesScreen />);
  fireEvent.changeText(screen.getByTestId('paired-devices-agent-name'), 'my-agent');
  fireEvent.press(screen.getByTestId('paired-devices-generate'));
  await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
  expect(screen.queryByTestId('paired-devices-setup-code')).toBeNull();
  fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
  fireEvent.press(screen.getByTestId('presence-submit'));
  await waitFor(() => expect(screen.getByTestId('paired-devices-setup-code')).toBeTruthy());
  expect(mockProve).toHaveBeenCalledWith('correct horse');
  expect(mockClient.mintCodingAgentCode).toHaveBeenCalledTimes(2);
});

it('revoking asks Core, then reloads the list', async () => {
  const screen = render(<PairedDevicesScreen />);
  await waitFor(() => expect(screen.getByTestId('paired-devices-revoke')).toBeTruthy());
  fireEvent.press(screen.getByTestId('paired-devices-revoke'));
  await waitFor(() => expect(mockClient.revokeDevice).toHaveBeenCalledWith('dev-claude'));
  await waitFor(() => expect(mockClient.status).toHaveBeenCalledTimes(2));
  expect(mockShowMessage).not.toHaveBeenCalled();
});

it('a revoke Core could not persist is reported, not claimed', async () => {
  mockClient.revokeDevice.mockRejectedValueOnce(
    new OwnerSetupHttpError('503', 503, 'device_revoke_not_durable'),
  );
  const screen = render(<PairedDevicesScreen />);
  await waitFor(() => expect(screen.getByTestId('paired-devices-revoke')).toBeTruthy());
  fireEvent.press(screen.getByTestId('paired-devices-revoke'));
  await waitFor(() =>
    expect(mockShowMessage).toHaveBeenCalledWith('Revoke not fully saved', expect.any(String)),
  );
});

describe('supervision (a coding agent only)', () => {
  it('with no choice made an agent reads as full supervision; a CLI has no picker', async () => {
    const screen = render(<PairedDevicesScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('paired-devices-supervision-dev-claude')).toBeTruthy(),
    );
    expect(
      screen.getByTestId('paired-devices-supervision-dev-claude-full_supervision').props
        .accessibilityState,
    ).toEqual({ selected: true });
    expect(screen.queryByTestId('paired-devices-supervision-dev-cli')).toBeNull();
  });

  it('choosing a level sends it with the version the owner saw; lowering asks for presence first', async () => {
    mockClient.agentPolicies.mockResolvedValue({
      policies: [
        {
          agent_did: CLAUDE.did,
          profile: 'sensitive_boundaries',
          policy_version: 3,
          revoked_at: null,
          owner_binding_status: 'active',
        },
      ],
      stale_policies: [],
    });
    mockClient.setAgentPolicy.mockRejectedValueOnce(presenceRefusal()).mockResolvedValue({});
    const screen = render(<PairedDevicesScreen />);
    await waitFor(() =>
      expect(
        screen.getByTestId('paired-devices-supervision-dev-claude-sensitive_boundaries').props
          .accessibilityState,
      ).toEqual({ selected: true }),
    );
    fireEvent.press(screen.getByTestId('paired-devices-supervision-dev-claude-network_protection'));
    await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(screen.getByTestId('presence-submit'));
    await waitFor(() => expect(mockClient.setAgentPolicy).toHaveBeenCalledTimes(2));
    expect(mockClient.setAgentPolicy).toHaveBeenLastCalledWith(CLAUDE.did, 'network_protection', 3);
  });

  it('a level an earlier owner identity chose says so, and full supervision applies', async () => {
    mockClient.agentPolicies.mockResolvedValue({
      policies: [],
      stale_policies: [
        {
          agent_did: CLAUDE.did,
          profile: 'network_protection',
          policy_version: 2,
          revoked_at: null,
          owner_binding_status: 'stale_owner_binding',
        },
      ],
    });
    const screen = render(<PairedDevicesScreen />);
    await waitFor(() => expect(screen.getByText(/identity changed/)).toBeTruthy());
    expect(
      screen.getByTestId('paired-devices-supervision-dev-claude-full_supervision').props
        .accessibilityState,
    ).toEqual({ selected: true });
    // Reconfirming names the stale version.
    fireEvent.press(screen.getByTestId('paired-devices-supervision-dev-claude-full_supervision'));
    await waitFor(() =>
      expect(mockClient.setAgentPolicy).toHaveBeenCalledWith(CLAUDE.did, 'full_supervision', 2),
    );
  });
});

describe('the approval phone (a server node only)', () => {
  it('the phone app, whose status names no phone, shows no such section', async () => {
    const screen = render(<PairedDevicesScreen />);
    await waitFor(() => expect(screen.getByText('Laptop Claude')).toBeTruthy());
    expect(screen.queryByTestId('approval-phone-state')).toBeNull();
  });

  it('a server node pairs a phone behind presence, and unpairs it after a question', async () => {
    mockClient.status.mockResolvedValue({
      devices: [CLAUDE],
      phone: { configured: false, state: 'unpaired' },
    });
    mockClient.pairApprovalPhone
      .mockRejectedValueOnce(presenceRefusal())
      .mockResolvedValue({ configured: true, state: 'active', phoneDid: 'did:plc:phone' });
    mockClient.revokeApprovalPhone.mockResolvedValue({ configured: false, state: 'unpaired' });
    const screen = render(<PairedDevicesScreen />);
    await waitFor(() => expect(screen.getByTestId('approval-phone-code')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('approval-phone-code'), ' dina1:phone ');
    fireEvent.press(screen.getByTestId('approval-phone-pair'));
    await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
    fireEvent.press(screen.getByTestId('presence-submit'));
    await waitFor(() => expect(screen.getByTestId('approval-phone-revoke')).toBeTruthy());
    expect(mockClient.pairApprovalPhone).toHaveBeenLastCalledWith('dina1:phone');
    expect(screen.getByTestId('approval-phone-state').props.children).toMatch(/did:plc:phone/);

    fireEvent.press(screen.getByTestId('approval-phone-revoke'));
    await waitFor(() => expect(screen.getByTestId('approval-phone-code')).toBeTruthy());
    expect(mockClient.revokeApprovalPhone).toHaveBeenCalledTimes(1);
  });
});

it('only a coding agent is offered as the connected Brain; a staff phone or CLI is not', async () => {
  mockRunClient = {
    reasoningBackends: jest.fn(async () => ({ backends: [] })),
    reasoningRegisterBackend: jest.fn(),
    reasoningRevokeBackend: jest.fn(),
  };
  const CLERK: OwnerSetupDeviceEntry = {
    ...CLAUDE,
    device_id: 'dev-clerk',
    name: 'Clerk',
    role: 'staff',
  };
  delete (CLERK as { scope?: string }).scope;
  mockClient.status.mockResolvedValue({ devices: [CLAUDE, CLERK] });
  const screen = render(<PairedDevicesScreen />);
  await waitFor(() => expect(screen.getByTestId('paired-devices-brain-dev-claude')).toBeTruthy());
  expect(screen.queryByTestId('paired-devices-brain-dev-clerk')).toBeNull();
});
