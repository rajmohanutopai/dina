/**
 * Shopping (UCP plan §4.2 U1): the shops Dina may search and what a search
 * tells them. A typed shop is reduced to its origin; an emptied field is left
 * out; Core's refusal names the field and the screen says why.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerUcpHttpError } from '@dina/core';

import ShoppingSettingsScreen, {
  isOldAndroid,
  sameSettings,
  shopOrigin,
  trimmedSettings,
} from '../../app/shopping-settings';

jest.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
const mockClient = {
  settings: jest.fn(),
  saveSettings: jest.fn(async (s: object) => ({ ...s, searching: true })),
  // No publisher on this node: the key section stays hidden (its own test covers it).
  publication: jest.fn(async () => null),
};
jest.mock('../../src/services/owner_ucp_client', () => ({
  getOwnerUcpClient: () => mockClient,
}));

beforeEach(() => jest.clearAllMocks());

it('adds a shop by its address, removes one, edits the context, and saves exactly that', async () => {
  mockClient.settings.mockResolvedValue({
    merchants: ['https://old-shop.example'],
    context: { address_country: 'DE', postal_code: '10115' },
  });
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('shopping-address_country').props.value).toBe('DE'));

  fireEvent.changeText(view.getByTestId('shopping-add-input'), 'Tea-Shop.example/products/sencha');
  fireEvent.press(view.getByTestId('shopping-add'));
  fireEvent.press(view.getByTestId('shopping-remove-https://old-shop.example'));
  // The postal code emptied is no longer sent.
  fireEvent.changeText(view.getByTestId('shopping-postal_code'), '');
  fireEvent.changeText(view.getByTestId('shopping-language'), 'de');
  fireEvent.press(view.getByTestId('shopping-save'));

  await waitFor(() => expect(mockClient.saveSettings).toHaveBeenCalled());
  expect(mockClient.saveSettings).toHaveBeenCalledWith({
    merchants: ['https://tea-shop.example'],
    context: { address_country: 'DE', language: 'de' },
  });
  await waitFor(() => expect(view.getByTestId('shopping-note').props.children).toBe('Saved.'));
});

it('says which field Core refused, in words', async () => {
  mockClient.settings.mockResolvedValue({ merchants: [], context: {} });
  mockClient.saveSettings.mockRejectedValueOnce(
    new OwnerUcpHttpError(
      'save ucp settings: HTTP 400',
      400,
      'invalid_settings',
      'address_country',
    ),
  );
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('shopping-address_country').props.value).toBe(''));
  fireEvent.changeText(view.getByTestId('shopping-address_country'), 'Germany');
  fireEvent.press(view.getByTestId('shopping-save'));
  await waitFor(() =>
    expect(view.getByTestId('shopping-note').props.children).toBe(
      'Use the two-letter country code, in capitals (e.g. DE).',
    ),
  );
});

it('until an edit, Save is off; an edit is marked unsaved until saved; fields go trimmed', async () => {
  mockClient.settings.mockResolvedValue({ merchants: [], context: { address_country: 'DE' } });
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('shopping-address_country').props.value).toBe('DE'));
  expect(view.getByTestId('shopping-save').props.accessibilityState?.disabled).toBe(true);
  expect(view.queryByTestId('shopping-unsaved')).toBeNull();
  fireEvent.changeText(view.getByTestId('shopping-address_region'), '  Bavaria ');
  expect(view.getByTestId('shopping-unsaved')).toBeTruthy();
  fireEvent.press(view.getByTestId('shopping-save'));
  await waitFor(() => expect(view.getByTestId('shopping-note').props.children).toBe('Saved.'));
  expect(mockClient.saveSettings).toHaveBeenCalledWith({
    merchants: [],
    context: { address_country: 'DE', address_region: 'Bavaria' },
  });
  expect(view.queryByTestId('shopping-unsaved')).toBeNull();
  // Typing a field back to what is saved is not an unsaved change; a new edit clears "Saved.".
  fireEvent.changeText(view.getByTestId('shopping-language'), 'de');
  expect(view.queryByTestId('shopping-note')).toBeNull();
  fireEvent.changeText(view.getByTestId('shopping-language'), '');
  expect(view.queryByTestId('shopping-unsaved')).toBeNull();
});

it('says when shop search is off on this Dina; the settings still load and save', async () => {
  mockClient.settings.mockResolvedValue({ merchants: [], context: {}, searching: false });
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('shopping-off')).toBeTruthy());
  mockClient.settings.mockResolvedValue({ merchants: [], context: {}, searching: true });
  const on = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(on.getByTestId('shopping-address_country').props.value).toBe(''));
  expect(on.queryByTestId('shopping-off')).toBeNull();
});

it('a field cleared and typed again as it was is no change', () => {
  const saved = {
    merchants: ['https://b.example', 'https://a.example'],
    context: { address_country: 'DE', language: 'de' },
  };
  // Retyped fields come back at the end; shops in another order; a field emptied is one left out.
  expect(
    sameSettings(saved, {
      merchants: ['https://a.example', 'https://b.example'],
      context: { language: 'de ', address_country: 'DE' },
    }),
  ).toBe(true);
  expect(sameSettings({ ...saved, context: { ...saved.context, postal_code: '' } }, saved)).toBe(
    true,
  );
  expect(
    sameSettings({ ...saved, context: { address_country: 'FR', language: 'de' } }, saved),
  ).toBe(false);
});

it('an edit typed while a save runs stays on screen, still unsaved', async () => {
  mockClient.settings.mockResolvedValue({ merchants: [], context: {}, searching: true });
  let finish: (v: unknown) => void = () => undefined;
  mockClient.saveSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('shopping-address_country').props.value).toBe(''));
  fireEvent.changeText(view.getByTestId('shopping-address_country'), 'DE');
  fireEvent.press(view.getByTestId('shopping-save'));
  fireEvent.changeText(view.getByTestId('shopping-language'), 'de');
  finish({ merchants: [], context: { address_country: 'DE' }, searching: true });
  await waitFor(() =>
    expect(view.getByTestId('shopping-note').props.children).toBe(
      'Saved. Your newer changes are not saved yet.',
    ),
  );
  expect(view.getByTestId('shopping-language').props.value).toBe('de');
  expect(view.getByTestId('shopping-unsaved')).toBeTruthy();
});

it('each control says what it does to a screen reader', async () => {
  mockClient.settings.mockResolvedValue({ merchants: ['https://a.example'], context: {} });
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => view.getByTestId('shopping-remove-https://a.example'));
  expect(view.getByTestId('shopping-remove-https://a.example').props.accessibilityLabel).toBe(
    'Remove https://a.example',
  );
  expect(view.getByTestId('shopping-add').props.accessibilityLabel).toBe('Add this shop');
  expect(view.getByTestId('shopping-add-input').props.accessibilityLabel).toBe(
    'Shop address to add',
  );
  expect(view.getByTestId('shopping-postal_code').props.accessibilityLabel).toBe('Postal code');
});

it('a field emptied by trimming is left out; Android 9 and older is told of its TLS limit', () => {
  expect(
    trimmedSettings({
      merchants: ['https://a.example'],
      context: { language: '  ', postal_code: ' 10115' },
    }),
  ).toEqual({ merchants: ['https://a.example'], context: { postal_code: '10115' } });
  expect(isOldAndroid('android', 28)).toBe(true);
  expect(isOldAndroid('android', 29)).toBe(false);
  expect(isOldAndroid('ios', '17.0')).toBe(false);
});

it('refuses a shop that is not an https address, without adding it', async () => {
  mockClient.settings.mockResolvedValue({ merchants: [], context: {} });
  const view = render(<ShoppingSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('shopping-add-input')).toBeTruthy());
  fireEvent.changeText(view.getByTestId('shopping-add-input'), 'http://plain.example');
  fireEvent.press(view.getByTestId('shopping-add'));
  expect(view.getByTestId('shopping-note').props.children).toMatch(/https:\/\//);
  expect(view.queryByTestId('shopping-remove-http://plain.example')).toBeNull();
});

it('a typed shop becomes its origin', () => {
  expect(shopOrigin('shop.example')).toBe('https://shop.example');
  expect(shopOrigin(' https://Shop.Example/path?q=1 ')).toBe('https://shop.example');
  expect(shopOrigin('http://shop.example')).toBeNull();
  expect(shopOrigin('https://user:pw@shop.example')).toBeNull();
  expect(shopOrigin('not a url at all')).toBeNull();
  // A public domain name only (simulator finding: "tea-shop" was added and saved).
  expect(shopOrigin('tea-shop')).toBeNull();
  expect(shopOrigin('localhost')).toBeNull();
  expect(shopOrigin('127.0.0.1')).toBeNull();
  expect(shopOrigin('shop.example.')).toBeNull();
});
