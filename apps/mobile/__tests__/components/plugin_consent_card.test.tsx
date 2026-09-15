/**
 * Tests for PluginConsentCard — the third-party plugin consent surface
 * (RESEARCHER_KERNEL_ARCHITECTURE.md §5.C2). The card renders the authenticated
 * consent summary (name, id, execution mode, the exact capabilities granted) and
 * is the one tap that turns a pending install `active`. We drive it against a
 * mocked service so the test pins the WIRING + the fail path, not the ceremony
 * (the ceremony is covered by plugin_install.test.ts).
 *
 * The runner leg pins PLUGIN_ARCHITECTURE §15.3: a setup code is shown, Install
 * stays disabled until Core reports the runner bound, and consent is confirmed
 * on THAT device.
 */

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { PluginConsentCard } from '../../src/components/PluginConsentCard';
import {
  checkRunnerPairing,
  confirmPluginInstall,
  declinePluginInstall,
  issueRunnerSetupCode,
} from '../../src/services/plugin_install';

import type { PluginConsentSummary } from '../../src/services/plugin_install';

jest.mock('../../src/services/plugin_install', () => ({
  checkRunnerPairing: jest.fn(),
  confirmPluginInstall: jest.fn(),
  declinePluginInstall: jest.fn(),
  issueRunnerSetupCode: jest.fn(),
}));

const checkMock = checkRunnerPairing as jest.MockedFunction<typeof checkRunnerPairing>;
const confirmMock = confirmPluginInstall as jest.MockedFunction<typeof confirmPluginInstall>;
const declineMock = declinePluginInstall as jest.MockedFunction<typeof declinePluginInstall>;
const issueMock = issueRunnerSetupCode as jest.MockedFunction<typeof issueRunnerSetupCode>;

const RUNNER_DID = 'did:key:z6MkRunnerDevice';

function summary(overrides: Partial<PluginConsentSummary> = {}): PluginConsentSummary {
  return {
    installId: 'inst-1',
    pluginId: 'com.acme.widget',
    displayName: 'Widget',
    version: '1.0.0',
    executionMode: 'runner',
    capabilities: ['Read a widget', 'List widgets'],
    ...overrides,
  };
}

beforeEach(() => {
  checkMock.mockReset().mockReturnValue({ state: 'waiting' });
  confirmMock.mockReset();
  declineMock.mockReset().mockResolvedValue({ removed: true });
  issueMock.mockReset().mockReturnValue({
    code: 'ABCDEFGH',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    setupCode: 'dina1:setup-code-for-the-runner',
  });
});

describe('PluginConsentCard (§5.C2)', () => {
  it('renders the name, id, execution mode, and every capability', () => {
    render(<PluginConsentCard consent={summary()} onDone={jest.fn()} />);

    expect(screen.getByTestId('plugin-consent-name-inst-1')).toHaveTextContent('Widget');
    // The runner-mode gloss is the kernel's core promise: never inside Dina.
    expect(screen.getByTestId('plugin-consent-mode-inst-1')).toHaveTextContent(/never inside Dina/i);
    // Rows render with a "• " bullet prefix, so match the capability substring.
    expect(screen.getByTestId('plugin-consent-cap-inst-1-0')).toHaveTextContent(/Read a widget/);
    expect(screen.getByTestId('plugin-consent-cap-inst-1-1')).toHaveTextContent(/List widgets/);
  });

  it('an interpreted plugin shows the data-not-code gloss and needs no pairing', () => {
    render(
      <PluginConsentCard consent={summary({ executionMode: 'interpreted' })} onDone={jest.fn()} />,
    );
    expect(screen.getByTestId('plugin-consent-mode-inst-1')).toHaveTextContent(/no code inside Dina/i);
    expect(screen.queryByTestId('plugin-consent-pairing-inst-1')).toBeNull();
    expect(issueMock).not.toHaveBeenCalled();
  });

  it('Install on an interpreted plugin confirms with no device and reports confirmed', async () => {
    confirmMock.mockResolvedValue({ ok: true });
    const onDone = jest.fn();
    render(<PluginConsentCard consent={summary({ executionMode: 'interpreted' })} onDone={onDone} />);

    fireEvent.press(screen.getByTestId('plugin-consent-install-inst-1'));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('confirmed'));
    expect(confirmMock).toHaveBeenCalledWith('inst-1', 'interpreted');
    expect(screen.queryByTestId('plugin-consent-install-inst-1')).toBeNull();
  });

  it('a runner plugin shows the setup code and keeps Install disabled until the runner is bound', async () => {
    const onDone = jest.fn();
    render(<PluginConsentCard consent={summary()} onDone={onDone} />);

    expect(issueMock).toHaveBeenCalledWith(summary());
    expect(screen.getByTestId('plugin-consent-setup-code-inst-1')).toHaveTextContent(
      'dina1:setup-code-for-the-runner',
    );
    expect(screen.getByTestId('plugin-consent-pairing-state-inst-1')).toHaveTextContent(/Waiting for the runner/);
    // Core has not bound anything: the tap must be inert (§15.3).
    fireEvent.press(screen.getByTestId('plugin-consent-install-inst-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('once Core binds the runner, Install confirms consent on THAT device', async () => {
    jest.useFakeTimers();
    try {
      checkMock
        .mockReturnValueOnce({ state: 'waiting' })
        .mockReturnValue({ state: 'bound', deviceDid: RUNNER_DID });
      confirmMock.mockResolvedValue({ ok: true });
      const onDone = jest.fn();
      render(<PluginConsentCard consent={summary()} onDone={onDone} />);
      expect(screen.getByTestId('plugin-consent-pairing-state-inst-1')).toHaveTextContent(/Waiting/);

      // The next poll sees the bind.
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(screen.getByTestId('plugin-consent-pairing-state-inst-1')).toHaveTextContent(/Identity bound/);
      expect(checkMock).toHaveBeenCalledWith('inst-1', 'ABCDEFGH');

      fireEvent.press(screen.getByTestId('plugin-consent-install-inst-1'));
      await act(async () => {
        await Promise.resolve();
      });
      // Never a device DID from the client: Core activates on the bound one.
      expect(confirmMock).toHaveBeenCalledWith('inst-1', 'runner');
      expect(onDone).toHaveBeenCalledWith('confirmed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('an expired setup code offers a fresh one', () => {
    checkMock.mockReturnValue({ state: 'expired' });
    render(<PluginConsentCard consent={summary()} onDone={jest.fn()} />);
    expect(screen.getByTestId('plugin-consent-pairing-state-inst-1')).toHaveTextContent(/expired/i);
    checkMock.mockReturnValue({ state: 'waiting' });
    fireEvent.press(screen.getByTestId('plugin-consent-reissue-inst-1'));
    expect(issueMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('plugin-consent-pairing-state-inst-1')).toHaveTextContent(/Waiting/);
  });

  it('a refused install (no longer pending) tells the owner to start again and keeps Install disabled', async () => {
    checkMock.mockReturnValue({ state: 'refused', error: 'the install request expired' });
    const onDone = jest.fn();
    render(<PluginConsentCard consent={summary()} onDone={onDone} />);
    expect(screen.getByTestId('plugin-consent-pairing-state-inst-1')).toHaveTextContent(/start again/i);
    fireEvent.press(screen.getByTestId('plugin-consent-install-inst-1'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('a failed confirm reports failed and says so', async () => {
    checkMock.mockReturnValue({ state: 'bound', deviceDid: RUNNER_DID });
    confirmMock.mockResolvedValue({ ok: false, error: 'consent refused' });
    const onDone = jest.fn();
    render(<PluginConsentCard consent={summary()} onDone={onDone} />);

    fireEvent.press(screen.getByTestId('plugin-consent-install-inst-1'));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('failed', 'consent refused'));
    expect(screen.getByTestId('plugin-consent-failed-inst-1')).toBeTruthy();
  });

  it('Decline tears the pending install down (revoking any paired runner) and reports declined', async () => {
    const onDone = jest.fn();
    render(<PluginConsentCard consent={summary()} onDone={onDone} />);

    fireEvent.press(screen.getByTestId('plugin-consent-decline-inst-1'));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('declined'));
    expect(declineMock).toHaveBeenCalledWith('inst-1');
    expect(screen.queryByTestId('plugin-consent-decline-inst-1')).toBeNull();
  });

  it('a plugin that requests nothing says so', () => {
    render(<PluginConsentCard consent={summary({ capabilities: [] })} onDone={jest.fn()} />);
    expect(screen.getByText(/requests no capabilities/i)).toBeTruthy();
  });
});
