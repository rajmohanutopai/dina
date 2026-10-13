/**
 * REAL_LIFE_FIXES_2 §18 — the AI providers screen says who checks each
 * reply (Jev on OpenRouter, else the owner's model), and offers the
 * on-device option only as a disabled "coming soon" button.
 */

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

let mockActive: string | null = 'openrouter';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  // Run the focus callback once, as on first focus.
  return { useFocusEffect: (cb: () => void) => useEffect(() => cb(), []) };
});
jest.mock('react-native-keyboard-controller', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});
jest.mock('../../src/ai/active_provider', () => ({
  peekActiveProvider: () => mockActive,
  loadActiveProvider: async () => mockActive,
  saveActiveProvider: async () => undefined,
  clearActiveProvider: async () => undefined,
}));
jest.mock('../../src/ai/agentic_swap', () => ({ swapAgenticActiveProvider: async () => true }));
jest.mock('../../src/ai/brain_wiring', () => ({ wireBrainChatProvider: async () => undefined }));
jest.mock('../../src/ai/model_overrides', () => ({ loadModelOverrides: async () => undefined, peekModelOverride: () => undefined }));
jest.mock('../../src/components/CreditsTile', () => ({ CreditsTile: () => null }));
jest.mock('../../src/components/key_health_pill', () => ({ KeyHealthPill: () => null }));
jest.mock('../../src/components/ModelPickerSheet', () => ({ ModelPickerSheet: () => null }));
jest.mock('../../src/components/ProviderPicker', () => ({ ProviderPicker: () => null }));
jest.mock('../../src/ai/provider', () => ({
  ...jest.requireActual('../../src/ai/provider'),
  getApiKey: async () => null,
  getConfiguredProviders: async () => (mockActive === null ? [] : [mockActive]),
}));

import AIProvidersScreen from '../../app/ai-providers';

it('names Jev when the model runs on OpenRouter, and the on-device button is disabled', async () => {
  mockActive = 'openrouter';
  const view = render(<AIProvidersScreen />);
  await waitFor(() => expect(view.getByTestId('small-checks')).toBeTruthy());
  expect(view.getByText(/Checked by Jev/)).toBeTruthy();
  const button = view.getByTestId('small-checks-on-device');
  expect(button.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  expect(view.getByText(/coming soon/)).toBeTruthy();
});

it("names the owner's model on any other provider", async () => {
  mockActive = 'claude';
  const view = render(<AIProvidersScreen />);
  await waitFor(() => expect(view.getByTestId('small-checks')).toBeTruthy());
  expect(view.getByText(/Checked by your model/)).toBeTruthy();
});
