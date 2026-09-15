/**
 * Render tests for the Business-identity screen (§5.D — the node's OWN paper
 * identity). Without it the India e-way-bill hook could only ever answer "no
 * GSTIN in your business settings", pointing at a screen that did not exist.
 *
 * The screen judges nothing: Core validates, and these pin that what the owner
 * typed reaches Core in the shape it takes, that a refusal lands beside the
 * field it belongs to and keeps the owner on their typing, and that stored
 * settings which no longer validate are shown as the fault they are.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import BusinessIdentityScreen from '../../app/business-identity';
import { getOwnerCommerceClient } from '../../src/services/owner_commerce_client';

const back = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back, push: jest.fn() }),
}));

jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: jest.fn(),
}));

const clientMock = getOwnerCommerceClient as jest.MockedFunction<typeof getOwnerCommerceClient>;
const GSTIN = '27AAPFU0939F1ZV';

function wireClient(over: Partial<{ businessIdentity: jest.Mock; saveBusinessIdentity: jest.Mock }> = {}) {
  const businessIdentity = over.businessIdentity ?? jest.fn(async () => ({ configured: false }));
  const saveBusinessIdentity = over.saveBusinessIdentity ?? jest.fn(async () => ({ ok: true }));
  clientMock.mockReturnValue({ businessIdentity, saveBusinessIdentity } as never);
  return { businessIdentity, saveBusinessIdentity };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the business-identity screen', () => {
  it('opens empty when nothing is configured — a node trades without a filing identity', async () => {
    wireClient();
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-legalName')).toBeTruthy());
    expect(view.getByTestId('business-identity-legalName').props.value).toBe('');
    expect(view.getByTestId('business-identity-gstin').props.value).toBe('');
  });

  it('shows what is stored', async () => {
    wireClient({
      businessIdentity: jest.fn(async () => ({
        configured: true,
        settings: {
          legalName: 'Utopai Furniture LLP',
          registrations: [{ scheme: 'gstin', value: GSTIN }],
          address: { line1: '12 Nehru Road', city: 'Bengaluru', postalCode: '560001', country: 'IN' },
        },
      })),
    });
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-legalName').props.value).toBe('Utopai Furniture LLP'));
    expect(view.getByTestId('business-identity-gstin').props.value).toBe(GSTIN);
    expect(view.getByTestId('business-identity-city').props.value).toBe('Bengaluru');
  });

  it('sends what was typed in the shape Core takes, and leaves on success', async () => {
    const { saveBusinessIdentity } = wireClient();
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-save')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('business-identity-legalName'), 'Utopai Furniture LLP');
    fireEvent.changeText(view.getByTestId('business-identity-gstin'), GSTIN);
    fireEvent.changeText(view.getByTestId('business-identity-line1'), '12 Nehru Road');
    fireEvent.changeText(view.getByTestId('business-identity-city'), 'Bengaluru');
    fireEvent.changeText(view.getByTestId('business-identity-country'), 'IN');
    fireEvent.press(view.getByTestId('business-identity-save'));

    await waitFor(() => expect(saveBusinessIdentity).toHaveBeenCalledTimes(1));
    expect(saveBusinessIdentity).toHaveBeenCalledWith({
      legalName: 'Utopai Furniture LLP',
      registrations: [{ scheme: 'gstin', value: GSTIN }],
      address: { line1: '12 Nehru Road', city: 'Bengaluru', country: 'IN' },
    });
    await waitFor(() => expect(back).toHaveBeenCalled());
  });

  it('an untouched address is omitted; an empty GSTIN clears the registrations', async () => {
    const { saveBusinessIdentity } = wireClient();
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-save')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('business-identity-legalName'), 'Utopai Furniture LLP');
    fireEvent.press(view.getByTestId('business-identity-save'));
    await waitFor(() => expect(saveBusinessIdentity).toHaveBeenCalled());
    expect(saveBusinessIdentity.mock.calls[0][0]).toEqual({
      legalName: 'Utopai Furniture LLP',
      registrations: [],
    });
  });

  it('shows a refusal beside its field and STAYS on the screen', async () => {
    const { saveBusinessIdentity } = wireClient({
      saveBusinessIdentity: jest.fn(async () => ({
        ok: false,
        findings: [
          { refusal: 'malformed_registration', field: 'registrations[0]', detail: 'the gstin does not pass its own format check' },
          { refusal: 'malformed_address', field: 'address.country', detail: 'country must be an ISO-3166-1 alpha-2 code' },
        ],
      })),
    });
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-save')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('business-identity-gstin'), '27AAPFU0939F1ZW');
    fireEvent.press(view.getByTestId('business-identity-save'));

    await waitFor(() => expect(view.getByTestId('business-identity-finding-gstin')).toBeTruthy());
    expect(view.getByTestId('business-identity-finding-country')).toBeTruthy();
    expect(saveBusinessIdentity).toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('a stored identity that no longer validates is a fault the owner sees, not a blank form', async () => {
    wireClient({
      businessIdentity: jest.fn(async () => ({
        configured: true,
        error: 'settings_invalid',
        findings: [{ refusal: 'empty_legal_name', field: 'legalName', detail: 'a filing prints a name' }],
      })),
    });
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-error')).toBeTruthy());
    expect(view.getByTestId('business-identity-finding-legalName')).toBeTruthy();
  });

  it('says so when Dina has not finished starting up, rather than failing silently', async () => {
    clientMock.mockReturnValue(null as never);
    const view = render(<BusinessIdentityScreen />);
    await waitFor(() => expect(view.getByTestId('business-identity-error')).toBeTruthy());
  });
});
