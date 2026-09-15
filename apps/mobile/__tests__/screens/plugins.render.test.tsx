/**
 * Render tests for the Plugins screen (RESEARCHER_KERNEL_ARCHITECTURE.md §5.C2).
 * The screen is the third-party install door + manage list; we drive it against
 * a mocked service so the test pins the SCREEN WIRING — the install form, the
 * begin → consent-card handoff, and the installed list — not the ceremony
 * (covered by plugin_install.test.ts) or the card (plugin_consent_card.test.tsx).
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

import { COUNTRY_PACK_MANIFESTS, type CountryPack } from '@dina/core';

import PluginsScreen from '../../app/plugins';
import {
  beginCountryPackInstall,
  beginPluginInstall,
  checkRunnerPairing,
  confirmPluginInstall,
  declinePluginInstall,
  listInstalledPlugins,
  pluginInstallAvailable,
  uninstallPlugin,
} from '../../src/services/plugin_install';

jest.mock('../../src/services/plugin_install', () => ({
  beginCountryPackInstall: jest.fn(),
  beginPluginInstall: jest.fn(),
  checkRunnerPairing: jest.fn(() => ({ state: 'waiting' })),
  confirmPluginInstall: jest.fn(),
  declinePluginInstall: jest.fn(async () => ({ removed: true })),
  issueRunnerSetupCode: jest.fn(() => ({ code: 'ABCDEFGH', expiresAt: 4_000_000_000, setupCode: 'dina1:x' })),
  pluginInstallAvailable: jest.fn(() => true),
  uninstallPlugin: jest.fn(),
  listInstalledPlugins: jest.fn(() => []),
}));

const beginMock = beginPluginInstall as jest.MockedFunction<typeof beginPluginInstall>;
const packMock = beginCountryPackInstall as jest.MockedFunction<typeof beginCountryPackInstall>;
const checkMock = checkRunnerPairing as jest.MockedFunction<typeof checkRunnerPairing>;
const confirmMock = confirmPluginInstall as jest.MockedFunction<typeof confirmPluginInstall>;
const declineMock = declinePluginInstall as jest.MockedFunction<typeof declinePluginInstall>;
const listMock = listInstalledPlugins as jest.MockedFunction<typeof listInstalledPlugins>;
const availableMock = pluginInstallAvailable as jest.MockedFunction<typeof pluginInstallAvailable>;
const uninstallMock = uninstallPlugin as jest.MockedFunction<typeof uninstallPlugin>;

const CONSENT = {
  installId: 'inst-9',
  pluginId: 'com.acme.widget',
  displayName: 'Widget',
  version: '1.0.0',
  executionMode: 'runner' as const,
  capabilities: ['Read a widget'],
};

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  beginMock.mockReset();
  packMock.mockReset();
  checkMock.mockReset().mockReturnValue({ state: 'waiting' });
  confirmMock.mockReset();
  declineMock.mockReset().mockResolvedValue({ removed: true });
  listMock.mockReset().mockReturnValue([]);
  availableMock.mockReset().mockReturnValue(true);
  uninstallMock.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  alertSpy.mockRestore();
});

/** Drive the install door to a staged consent card for CONSENT. */
async function stage(screen: ReturnType<typeof render>): Promise<void> {
  beginMock.mockResolvedValue({ ok: true, consent: CONSENT });
  fireEvent.changeText(screen.getByTestId('plugins-publisher-did'), 'did:plc:acme');
  fireEvent.changeText(screen.getByTestId('plugins-rkey'), 'rkey123');
  fireEvent.press(screen.getByTestId('plugins-begin'));
  await waitFor(() => expect(screen.getByTestId('plugin-consent-card-inst-9')).toBeTruthy());
}

/** The destructive button of the last confirm Alert, pressed. */
function pressDestructive(): void {
  const buttons = alertSpy.mock.calls.at(-1)?.[2] as { style?: string; onPress?: () => void }[] | undefined;
  const destructive = buttons?.find((b) => b.style === 'destructive');
  if (destructive?.onPress === undefined) throw new Error('no destructive button on the last alert');
  destructive.onPress();
}

describe('PluginsScreen — render', () => {
  it('shows the empty state and the install form', () => {
    const { getByTestId, getByText } = render(<PluginsScreen />);
    expect(getByText('No plugins installed yet.')).toBeTruthy();
    expect(getByTestId('plugins-publisher-did')).toBeTruthy();
    expect(getByTestId('plugins-rkey')).toBeTruthy();
    expect(getByTestId('plugins-begin')).toBeTruthy();
  });

  it('lists installed plugins with an uninstall control', () => {
    listMock.mockReturnValue([
      { installId: 'inst-1', pluginId: 'com.acme.widget', status: 'active', executionMode: 'runner' },
    ]);
    const { getByTestId } = render(<PluginsScreen />);
    expect(getByTestId('plugin-row-inst-1')).toBeTruthy();
    expect(getByTestId('plugin-uninstall-inst-1')).toBeTruthy();
  });

  it('with no verifier on this phone the install door is closed and says so; the manage list still works', () => {
    availableMock.mockReturnValue(false);
    listMock.mockReturnValue([
      { installId: 'inst-1', pluginId: 'com.acme.widget', status: 'active', executionMode: 'runner' },
    ]);
    const { getByTestId, queryByTestId } = render(<PluginsScreen />);
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
    const contains = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
    packMock.mockReturnValue({ state: 'staged', consent: PACK_CONSENT });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-in'));
    expect(packMock).toHaveBeenCalledWith('in');
    // No fetch, no verifier — the third-party door was never involved.
    expect(beginMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('plugin-consent-card-inst-in')).toBeTruthy());
    // While the consent is undecided both install doors give way to the card.
    expect(screen.queryByTestId('plugins-country-pack-install-in')).toBeNull();
    expect(screen.queryByTestId('plugins-begin')).toBeNull();
  });

  it('a pack the owner already granted says so instead of stacking a second consent', () => {
    packMock.mockReturnValue({ state: 'already_active', installId: 'inst-in' });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-in'));
    expect(alertSpy).toHaveBeenCalledWith('Already installed', expect.any(String));
    expect(screen.queryByTestId('plugin-consent-card-inst-in')).toBeNull();
  });

  it('a refusal tells the owner whether to try again', () => {
    packMock.mockReturnValue({ state: 'refused', error: 'Node identity not ready yet', transient: true });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-us'));
    expect(alertSpy).toHaveBeenCalledWith('Not ready yet', expect.stringMatching(/Try again/));
  });

  it('Cancel on a staged pack tears the pending install down like any other', async () => {
    packMock.mockReturnValue({ state: 'staged', consent: PACK_CONSENT });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugins-country-pack-install-in'));
    await waitFor(() => expect(screen.getByTestId('plugin-consent-card-inst-in')).toBeTruthy());
    fireEvent.press(screen.getByTestId('plugins-dismiss-pending'));
    await waitFor(() => expect(screen.queryByTestId('plugin-consent-card-inst-in')).toBeNull(), { timeout: 3000 });
    expect(declineMock).toHaveBeenCalledWith('inst-in');
  });
});

describe('PluginsScreen — uninstall', () => {
  const ROW = { installId: 'inst-1', pluginId: 'com.acme.widget', status: 'active' as const, executionMode: 'runner' as const };

  it('confirms, uninstalls, and re-reads the list', async () => {
    listMock.mockReturnValue([ROW]);
    uninstallMock.mockResolvedValue({ ok: true });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugin-uninstall-inst-1'));
    expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/Uninstall/), expect.any(String), expect.any(Array));
    const reads = listMock.mock.calls.length;
    listMock.mockReturnValue([]);
    await act(async () => {
      pressDestructive();
      await Promise.resolve();
    });
    expect(uninstallMock).toHaveBeenCalledWith('inst-1');
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByTestId('plugin-row-inst-1')).toBeNull());
  });

  it.each([
    ['unknown_install', /Nothing to uninstall/],
    ['obligations_open', /Orders still open/],
    ['teardown_incomplete', /not fully/],
  ] as const)('a refused uninstall (%s) names why', async (error, title) => {
    listMock.mockReturnValue([ROW]);
    uninstallMock.mockResolvedValue({ ok: false, error });
    const screen = render(<PluginsScreen />);
    fireEvent.press(screen.getByTestId('plugin-uninstall-inst-1'));
    await act(async () => {
      pressDestructive();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(title), expect.any(String)),
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
    fireEvent.changeText(getByTestId('plugins-publisher-did'), 'did:plc:acme');
    fireEvent.changeText(getByTestId('plugins-rkey'), 'rkey123');
    fireEvent.press(getByTestId('plugins-begin'));

    await waitFor(() => expect(getByTestId('plugin-consent-card-inst-9')).toBeTruthy());
    expect(beginMock).toHaveBeenCalledWith('did:plc:acme', 'rkey123');
  });

  it('the install on the card is not repeated in the manage list', async () => {
    listMock.mockReturnValue([
      { installId: 'inst-9', pluginId: 'com.acme.widget', status: 'pending', executionMode: 'runner' },
      { installId: 'inst-old', pluginId: 'com.acme.older', status: 'pending', executionMode: 'runner' },
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
    await waitFor(() => expect(screen.queryByTestId('plugin-consent-card-inst-9')).toBeNull(), { timeout: 3000 });
    expect(declineMock).toHaveBeenCalledWith('inst-9');
  });

  it('a failed confirm tears the staged install down so nothing lingers with no card', async () => {
    checkMock.mockReturnValue({ state: 'bound', deviceDid: 'did:key:z6MkRunner' });
    confirmMock.mockResolvedValue({ ok: false, error: 'consent refused' });
    const screen = render(<PluginsScreen />);
    await stage(screen);

    fireEvent.press(screen.getByTestId('plugin-consent-install-inst-9'));
    await waitFor(() => expect(screen.queryByTestId('plugin-consent-card-inst-9')).toBeNull(), { timeout: 3000 });
    expect(declineMock).toHaveBeenCalledWith('inst-9');
    expect(alertSpy).toHaveBeenCalledWith('Install failed', 'consent refused');
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
    beginMock.mockResolvedValue({ ok: false, error: 'This phone cannot verify third-party plugins yet.', transient: false, unavailable: true });
    const screen = render(<PluginsScreen />);
    fireEvent.changeText(screen.getByTestId('plugins-publisher-did'), 'did:plc:acme');
    fireEvent.changeText(screen.getByTestId('plugins-rkey'), 'rkey123');
    fireEvent.press(screen.getByTestId('plugins-begin'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Not available on this phone yet', expect.any(String)));
    expect(alertSpy).not.toHaveBeenCalledWith(expect.stringMatching(/reach the publisher/), expect.anything());
  });

  it('does not begin with empty inputs', () => {
    const { getByTestId } = render(<PluginsScreen />);
    fireEvent.press(getByTestId('plugins-begin'));
    expect(beginMock).not.toHaveBeenCalled();
  });
});
