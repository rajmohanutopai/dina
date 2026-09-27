/**
 * Render tests for the Plugins screen (RESEARCHER_KERNEL_ARCHITECTURE.md §5.C2).
 * The screen is the third-party install door + manage list; we drive it against
 * a mocked service so the test pins the SCREEN WIRING — the install form, the
 * begin → consent-card handoff, and the installed list — not the ceremony
 * (covered by plugin_install.test.ts) or the card (plugin_consent_card.test.tsx).
 * Questions go through `confirmDecision` and messages through `showMessage`
 * (RN-Web's Alert does nothing), so those are what the tests read.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { COUNTRY_PACK_MANIFESTS, type CountryPack } from '@dina/core';

import PluginsScreen from '../../app/plugins';
import {
  beginCountryPackInstall,
  beginPluginInstall,
  checkRunnerPairing,
  confirmPluginInstall,
  declinePluginInstall,
  applyPackUpdate,
  listPackUpdates,
  loadPlugins,
  reviewPackUpdate,
  uninstallPlugin,
  type InstalledPlugin,
} from '../../src/services/plugin_install';

jest.mock('../../src/services/plugin_install', () => ({
  beginCountryPackInstall: jest.fn(),
  beginPluginInstall: jest.fn(),
  checkRunnerPairing: jest.fn(async () => ({ state: 'waiting' })),
  confirmPluginInstall: jest.fn(),
  declinePluginInstall: jest.fn(async () => ({ removed: true })),
  issueRunnerSetupCode: jest.fn(async () => ({
    code: 'ABCDEFGH',
    expiresAt: 4_000_000_000,
    setupCode: 'dina1:x',
  })),
  uninstallPlugin: jest.fn(),
  loadPlugins: jest.fn(async () => ({ installed: [], thirdPartyAvailable: true })),
  listPackUpdates: jest.fn(async () => []),
  reviewPackUpdate: jest.fn(),
  applyPackUpdate: jest.fn(async () => ({ ok: true })),
}));
const mockConfirm = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../../src/services/confirm_decision', () => ({
  confirmDecision: (...args: unknown[]) => mockConfirm(...args),
}));
const mockShowMessage = jest.fn();
jest.mock('../../src/services/show_message', () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
}));
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => ({ provePresence: jest.fn(async () => ({ ok: true })) }),
}));

const beginMock = beginPluginInstall as jest.MockedFunction<typeof beginPluginInstall>;
const packMock = beginCountryPackInstall as jest.MockedFunction<typeof beginCountryPackInstall>;
const checkMock = checkRunnerPairing as jest.MockedFunction<typeof checkRunnerPairing>;
const confirmMock = confirmPluginInstall as jest.MockedFunction<typeof confirmPluginInstall>;
const declineMock = declinePluginInstall as jest.MockedFunction<typeof declinePluginInstall>;
const loadMock = loadPlugins as jest.MockedFunction<typeof loadPlugins>;
const uninstallMock = uninstallPlugin as jest.MockedFunction<typeof uninstallPlugin>;

/** What `loadPlugins` answers: these installs, the third-party door open unless said. */
function installs(installed: InstalledPlugin[], thirdPartyAvailable = true): void {
  loadMock.mockResolvedValue({ installed, thirdPartyAvailable });
}

const CONSENT = {
  installId: 'inst-9',
  pluginId: 'com.acme.widget',
  displayName: 'Widget',
  version: '1.0.0',
  executionMode: 'runner' as const,
  capabilities: ['Read a widget'],
};

beforeEach(() => {
  beginMock.mockReset();
  packMock.mockReset();
  checkMock.mockReset().mockResolvedValue({ state: 'waiting' });
  confirmMock.mockReset();
  declineMock.mockReset().mockResolvedValue({ removed: true });
  loadMock.mockReset();
  installs([]);
  uninstallMock.mockReset();
  mockConfirm.mockReset().mockResolvedValue(true);
  mockShowMessage.mockReset();
});

/** Drive the install door to a staged consent card for CONSENT. */
async function stage(screen: ReturnType<typeof render>): Promise<void> {
  beginMock.mockResolvedValue({ ok: true, consent: CONSENT });
  await waitFor(() => expect(screen.getByTestId('plugins-publisher-did')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('plugins-publisher-did'), 'did:plc:acme');
  fireEvent.changeText(screen.getByTestId('plugins-rkey'), 'rkey123');
  fireEvent.press(screen.getByTestId('plugins-begin'));
  await waitFor(() => expect(screen.getByTestId('plugin-consent-card-inst-9')).toBeTruthy());
}

describe('PluginsScreen — render', () => {
  it('shows the empty state and the install form', async () => {
    const { getByTestId, getByText } = render(<PluginsScreen />);
    expect(getByText('No plugins installed yet.')).toBeTruthy();
    await waitFor(() => expect(getByTestId('plugins-publisher-did')).toBeTruthy());
    expect(getByTestId('plugins-rkey')).toBeTruthy();
    expect(getByTestId('plugins-begin')).toBeTruthy();
  });

  it('a browser not connected as the owner is told to connect, with no misleading install text', async () => {
    loadMock.mockRejectedValue(
      Object.assign(new Error('401'), { errorKey: 'owner_device_not_connected' }),
    );
    const screen = render(<PluginsScreen />);
    await waitFor(() =>
      expect(String(screen.getByTestId('plugins-empty').props.children)).toMatch(
        /Connect this browser as the owner/,
      ),
    );
    expect(screen.queryByTestId('plugins-unavailable')).toBeNull();
    expect(screen.queryByTestId('plugins-publisher-did')).toBeNull();
  });

  it('lists installed plugins with an uninstall control', async () => {
    installs([
      {
        installId: 'inst-1',
        pluginId: 'com.acme.widget',
        status: 'active',
        executionMode: 'runner',
      },
    ]);
    const { getByTestId } = render(<PluginsScreen />);
    await waitFor(() => expect(getByTestId('plugin-row-inst-1')).toBeTruthy());
    expect(getByTestId('plugin-uninstall-inst-1')).toBeTruthy();
  });

  it('with no verifier on this node the install door is closed and says so; the manage list still works', async () => {
    installs(
      [
        {
          installId: 'inst-1',
          pluginId: 'com.acme.widget',
          status: 'active',
          executionMode: 'runner',
        },
      ],
      false,
    );
    const { getByTestId, queryByTestId } = render(<PluginsScreen />);
    await waitFor(() => expect(getByTestId('plugin-row-inst-1')).toBeTruthy());
    expect(getByTestId('plugins-unavailable')).toBeTruthy();
    expect(queryByTestId('plugins-begin')).toBeNull();
    expect(getByTestId('plugin-uninstall-inst-1')).toBeTruthy();
    // The first-party door needs no verifier — the country packs stay open.
    expect(getByTestId('plugins-country-pack-install-in')).toBeTruthy();
    expect(getByTestId('plugins-country-pack-install-us')).toBeTruthy();
  });

  it('lists every shipped country pack from the manifest table, with what each brings', () => {
    const { getByTestId, getAllByTestId } = render(<PluginsScreen />);
    const packs = Object.keys(COUNTRY_PACK_MANIFESTS) as CountryPack[];
    expect(packs.length).toBeGreaterThanOrEqual(2);
    // One row per key of the table — a pack added to core cannot be left off the screen.
    expect(getAllByTestId(/^plugins-country-pack-install-/)).toHaveLength(packs.length);
    // `toHaveTextContent(string)` matches the WHOLE row; the row also carries
    // the button label, so match each manifest field as a substring.
    const contains = (text: string): RegExp =>
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const pack of packs) {
      const manifest = COUNTRY_PACK_MANIFESTS[pack];
      const row = getByTestId(`plugins-country-pack-${pack}`);
      expect(row).toHaveTextContent(contains(manifest.display_name));
      expect(row).toHaveTextContent(contains(manifest.short_description ?? ''));
    }
  });
});

describe('PluginsScreen — country packs (§5.D)', () => {
  const PACK_CONSENT = {
    installId: 'inst-in',
    pluginId: 'com.dinakernel.country.in',
    displayName: 'Country pack — India',
    version: '1.0.0',
    executionMode: 'runner' as const,
    capabilities: ['Check whether a UPI payment settled'],
  };

  it('Install on a pack stages it through the first-party door and shows the consent card', async () => {
    packMock.mockResolvedValue({ state: 'staged', consent: PACK_CONSENT });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-in'));
    await waitFor(() => expect(packMock).toHaveBeenCalledWith('in'));
    // No fetch, no verifier — the third-party door was never involved.
    expect(beginMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('plugin-consent-card-inst-in')).toBeTruthy());
    // While the consent is undecided both install doors give way to the card.
    expect(screen.queryByTestId('plugins-country-pack-install-in')).toBeNull();
    expect(screen.queryByTestId('plugins-begin')).toBeNull();
  });

  it('a pack the owner already granted says so instead of stacking a second consent', async () => {
    packMock.mockResolvedValue({ state: 'already_active', installId: 'inst-in' });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-in'));
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('Already installed', expect.any(String)),
    );
    expect(screen.queryByTestId('plugin-consent-card-inst-in')).toBeNull();
  });

  it('a refusal tells the owner whether to try again', async () => {
    packMock.mockResolvedValue({
      state: 'refused',
      error: 'Node identity not ready yet',
      transient: true,
    });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-us'));
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        'Not ready yet',
        expect.stringMatching(/Try again/),
      ),
    );
  });

  it('Cancel on a staged pack tears the pending install down like any other', async () => {
    packMock.mockResolvedValue({ state: 'staged', consent: PACK_CONSENT });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-in'));
    await waitFor(() => expect(screen.getByTestId('plugin-consent-card-inst-in')).toBeTruthy());
    fireEvent.press(screen.getByTestId('plugins-dismiss-pending'));
    await waitFor(() => expect(screen.queryByTestId('plugin-consent-card-inst-in')).toBeNull(), {
      timeout: 3000,
    });
    expect(declineMock).toHaveBeenCalledWith('inst-in');
  });
});

describe('PluginsScreen — uninstall', () => {
  const ROW = {
    installId: 'inst-1',
    pluginId: 'com.acme.widget',
    status: 'active' as const,
    executionMode: 'runner' as const,
  };

  it('confirms, uninstalls, and re-reads the list', async () => {
    installs([ROW]);
    uninstallMock.mockResolvedValue({ ok: true });
    const screen = render(<PluginsScreen />);
    await waitFor(() => expect(screen.getByTestId('plugin-uninstall-inst-1')).toBeTruthy());
    const reads = loadMock.mock.calls.length;
    installs([]);
    fireEvent.press(screen.getByTestId('plugin-uninstall-inst-1'));
    await waitFor(() => expect(uninstallMock).toHaveBeenCalledWith('inst-1'));
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringMatching(/Uninstall/),
      expect.any(String),
      'Uninstall',
      true,
    );
    await waitFor(() => expect(loadMock.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByTestId('plugin-row-inst-1')).toBeNull());
  });

  it('a no on the question uninstalls nothing', async () => {
    installs([ROW]);
    mockConfirm.mockResolvedValueOnce(false);
    const screen = render(<PluginsScreen />);
    await waitFor(() => expect(screen.getByTestId('plugin-uninstall-inst-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('plugin-uninstall-inst-1'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown_install', /Nothing to uninstall/],
    ['obligations_open', /Orders still open/],
    ['teardown_incomplete', /not fully/],
  ] as const)('a refused uninstall (%s) names why', async (error, title) => {
    installs([ROW]);
    uninstallMock.mockResolvedValue({ ok: false, error });
    const screen = render(<PluginsScreen />);
    await waitFor(() => expect(screen.getByTestId('plugin-uninstall-inst-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('plugin-uninstall-inst-1'));
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(
        expect.stringMatching(title),
        expect.any(String),
      ),
    );
  });
});

describe('PluginsScreen — begin → consent', () => {
  it('a verified release surfaces the consent card', async () => {
    beginMock.mockResolvedValue({
      ok: true,
      consent: {
        installId: 'inst-9',
        pluginId: 'com.acme.widget',
        displayName: 'Widget',
        version: '1.0.0',
        executionMode: 'runner',
        capabilities: ['Read a widget'],
      },
    });

    const { getByTestId } = render(<PluginsScreen />);
    await waitFor(() => expect(getByTestId('plugins-publisher-did')).toBeTruthy());
    fireEvent.changeText(getByTestId('plugins-publisher-did'), 'did:plc:acme');
    fireEvent.changeText(getByTestId('plugins-rkey'), 'rkey123');
    fireEvent.press(getByTestId('plugins-begin'));

    await waitFor(() => expect(getByTestId('plugin-consent-card-inst-9')).toBeTruthy());
    expect(beginMock).toHaveBeenCalledWith('did:plc:acme', 'rkey123');
  });

  it('the install on the card is not repeated in the manage list', async () => {
    installs([
      {
        installId: 'inst-9',
        pluginId: 'com.acme.widget',
        status: 'pending',
        executionMode: 'runner',
      },
      {
        installId: 'inst-old',
        pluginId: 'com.acme.older',
        status: 'pending',
        executionMode: 'runner',
      },
    ]);
    beginMock.mockResolvedValue({
      ok: true,
      consent: {
        installId: 'inst-9',
        pluginId: 'com.acme.widget',
        displayName: 'Widget',
        version: '1.0.0',
        executionMode: 'runner',
        capabilities: [],
      },
    });
    const { getByTestId, queryByTestId } = render(<PluginsScreen />);
    await waitFor(() => expect(getByTestId('plugin-row-inst-old')).toBeTruthy());
    fireEvent.changeText(getByTestId('plugins-publisher-did'), 'did:plc:acme');
    fireEvent.changeText(getByTestId('plugins-rkey'), 'rkey123');
    fireEvent.press(getByTestId('plugins-begin'));
    await waitFor(() => expect(getByTestId('plugin-consent-card-inst-9')).toBeTruthy());
    // Decided on the card, not listed twice; an older abandoned pending stays removable.
    expect(queryByTestId('plugin-row-inst-9')).toBeNull();
    expect(getByTestId('plugin-row-inst-old')).toBeTruthy();
  });

  it('Cancel on a pending consent tears the staged install down', async () => {
    const screen = render(<PluginsScreen />);
    await stage(screen);

    fireEvent.press(screen.getByTestId('plugins-dismiss-pending'));
    // The decline is a resolved promise settled through `.finally`; on a cold
    // ts-jest transform cache the first tick can exceed RNTL's 1 s default.
    await waitFor(() => expect(screen.queryByTestId('plugin-consent-card-inst-9')).toBeNull(), {
      timeout: 3000,
    });
    expect(declineMock).toHaveBeenCalledWith('inst-9');
  });

  it('a failed confirm tears the staged install down so nothing lingers with no card', async () => {
    checkMock.mockResolvedValue({ state: 'bound', deviceDid: 'did:key:z6MkRunner' });
    confirmMock.mockResolvedValue({ ok: false, error: 'consent refused' });
    const screen = render(<PluginsScreen />);
    await stage(screen);

    await waitFor(() =>
      expect(screen.getByTestId('plugin-consent-install-inst-9').props.accessibilityState).toEqual({
        disabled: false,
      }),
    );
    fireEvent.press(screen.getByTestId('plugin-consent-install-inst-9'));
    await waitFor(() => expect(screen.queryByTestId('plugin-consent-card-inst-9')).toBeNull(), {
      timeout: 3000,
    });
    expect(declineMock).toHaveBeenCalledWith('inst-9');
    expect(mockShowMessage).toHaveBeenCalledWith('Install failed', 'consent refused');
  });

  it('LEAVING the screen with a consent undecided declines it (§15.3 one cleanup path)', async () => {
    const screen = render(<PluginsScreen />);
    await stage(screen);
    expect(declineMock).not.toHaveBeenCalled();
    // The focus effect's cleanup runs on blur; the jest mock runs it on unmount.
    screen.unmount();
    expect(declineMock).toHaveBeenCalledWith('inst-9');
  });

  it('a build that cannot verify reports the absence, never a network problem', async () => {
    beginMock.mockResolvedValue({
      ok: false,
      error: 'This node cannot verify third-party plugins yet.',
      transient: false,
      unavailable: true,
    });
    const screen = render(<PluginsScreen />);
    await waitFor(() => expect(screen.getByTestId('plugins-publisher-did')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('plugins-publisher-did'), 'did:plc:acme');
    fireEvent.changeText(screen.getByTestId('plugins-rkey'), 'rkey123');
    fireEvent.press(screen.getByTestId('plugins-begin'));
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('Not available here yet', expect.any(String)),
    );
    expect(mockShowMessage).not.toHaveBeenCalledWith(
      expect.stringMatching(/reach the publisher/),
      expect.anything(),
    );
  });

  it('does not begin with empty inputs', async () => {
    const { getByTestId } = render(<PluginsScreen />);
    await waitFor(() => expect(getByTestId('plugins-begin')).toBeTruthy());
    fireEvent.press(getByTestId('plugins-begin'));
    expect(beginMock).not.toHaveBeenCalled();
  });
});

describe('item 1 — a pack the app ships updates in place', () => {
  const updatesMock = listPackUpdates as jest.MockedFunction<typeof listPackUpdates>;
  const reviewMock = reviewPackUpdate as jest.MockedFunction<typeof reviewPackUpdate>;
  const applyMock = applyPackUpdate as jest.MockedFunction<typeof applyPackUpdate>;
  const REVIEW = {
    installId: 'inst-sup',
    toCid: 'bafy-1-1-0',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    changes: ['capability added: com.dinakernel.commerce.negotiate-quote'],
    behaviorChanged: true,
    widening: [
      {
        kind: 'capability_added',
        capabilityId: 'com.dinakernel.commerce.negotiate-quote',
        to: 'x',
      },
    ],
    toBehaviorHash: 'h'.repeat(64),
  };

  it('offers "Update to 1.1.0", shows what changes, and applies only on the second tap', async () => {
    installs([
      {
        installId: 'inst-sup',
        pluginId: 'com.dinakernel.commerce.supplier',
        status: 'active',
        executionMode: 'runner',
      },
    ]);
    updatesMock.mockResolvedValue([
      {
        installId: 'inst-sup',
        pluginId: 'com.dinakernel.commerce.supplier',
        displayName: 'Supplier pack',
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
      },
    ]);
    reviewMock.mockResolvedValue({ ok: true, review: REVIEW as never });
    mockConfirm.mockResolvedValueOnce(false);
    const { getByTestId, getByText } = render(<PluginsScreen />);
    await waitFor(() => expect(getByText('Update to 1.1.0')).toBeTruthy());
    // Looking is not applying: a no applies nothing.
    fireEvent.press(getByTestId('plugin-update-inst-sup'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    const [title, body] = mockConfirm.mock.calls[0] as [string, string];
    expect(title).toBe('Update this pack?');
    expect(body).toMatch(/1\.0\.0 → 1\.1\.0/);
    expect(body).toMatch(/negotiate-quote/);
    expect(body).toMatch(/Orders already open stay with this pack/);
    expect(applyMock).not.toHaveBeenCalled();
    // The second tap, answered yes, applies the reviewed update.
    fireEvent.press(getByTestId('plugin-update-inst-sup'));
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith(REVIEW));
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('Updated', expect.stringMatching(/1\.1\.0/)),
    );
  });
});
