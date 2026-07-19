/**
 * AiProviderSet — the mandatory onboarding "Connect your AI" step. Verifies it
 * (a) auto-satisfies when a provider is already configured (dev/env key),
 * (b) validates a pasted key with a live probe before continuing, and
 * (c) blocks (no continue) when the probe rejects the key.
 */

jest.mock('../../src/ai/provider', () => ({
  PROVIDERS: {
    gemini: { label: 'Google Gemini' },
    openai: { label: 'OpenAI' },
    claude: { label: 'Anthropic Claude' },
    openrouter: { label: 'OpenRouter' },
  },
  getConfiguredProviders: jest.fn(async () => []),
  saveApiKey: jest.fn(async () => undefined),
  validateKeyFormat: jest.fn(() => null),
  verifyKey: jest.fn(async () => null),
}));
jest.mock('../../src/ai/active_provider', () => ({
  loadActiveProvider: jest.fn(async () => null),
  saveActiveProvider: jest.fn(async () => undefined),
}));

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { saveActiveProvider } from '../../src/ai/active_provider';
import {
  getConfiguredProviders,
  saveApiKey,
  verifyKey,
} from '../../src/ai/provider';
import { AiProviderSet } from '../../src/components/onboarding/ai_provider_set';

const LOC = { current: 6, total: 7, label: 'Connect AI' };

beforeEach(() => {
  jest.clearAllMocks();
  (getConfiguredProviders as jest.Mock).mockResolvedValue([]);
  (verifyKey as jest.Mock).mockResolvedValue(null);
});

describe('AiProviderSet', () => {
  it('auto-satisfies when a provider is already configured (dev/env key)', async () => {
    (getConfiguredProviders as jest.Mock).mockResolvedValue(['gemini']);
    const onContinue = jest.fn();
    render(<AiProviderSet location={LOC} onBack={jest.fn()} onContinue={onContinue} />);

    await waitFor(() => expect(screen.getByTestId('onboarding-ai-connected')).toBeTruthy());
    expect(screen.getByText(/Google Gemini connected/)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('shell-primary'));
    });
    expect(saveActiveProvider).toHaveBeenCalledWith('gemini');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('validates a pasted key with a live probe, then saves + continues', async () => {
    const onContinue = jest.fn();
    render(<AiProviderSet location={LOC} onBack={jest.fn()} onContinue={onContinue} />);

    await waitFor(() => expect(screen.getByTestId('onboarding-ai-provider-gemini')).toBeTruthy());
    fireEvent.press(screen.getByTestId('onboarding-ai-provider-gemini'));
    fireEvent.changeText(screen.getByTestId('onboarding-ai-key-input'), 'AIzaTESTKEY');
    await act(async () => {
      fireEvent.press(screen.getByTestId('shell-primary'));
    });

    expect(verifyKey).toHaveBeenCalledWith('gemini', 'AIzaTESTKEY');
    expect(saveApiKey).toHaveBeenCalledWith('gemini', 'AIzaTESTKEY');
    expect(saveActiveProvider).toHaveBeenCalledWith('gemini');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('blocks (no continue) and shows the probe error when the key is rejected', async () => {
    (verifyKey as jest.Mock).mockResolvedValue('Key didn’t work: 401');
    const onContinue = jest.fn();
    render(<AiProviderSet location={LOC} onBack={jest.fn()} onContinue={onContinue} />);

    await waitFor(() => expect(screen.getByTestId('onboarding-ai-provider-gemini')).toBeTruthy());
    fireEvent.press(screen.getByTestId('onboarding-ai-provider-gemini'));
    fireEvent.changeText(screen.getByTestId('onboarding-ai-key-input'), 'AIzaBAD');
    await act(async () => {
      fireEvent.press(screen.getByTestId('shell-primary'));
    });

    expect(screen.getByTestId('onboarding-ai-error')).toBeTruthy();
    expect(saveApiKey).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
