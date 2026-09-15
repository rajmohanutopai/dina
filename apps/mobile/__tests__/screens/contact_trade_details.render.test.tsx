/**
 * Render tests for the Trade-details screen (RESEARCHER_KERNEL_ARCHITECTURE
 * §5.D — the capture path the country-pack hooks were missing).
 *
 * The screen judges NOTHING: Core validates and answers with findings, and the
 * screen's job is to load what is stated, send what was typed, show a refusal
 * beside the field it belongs to, and leave the screen open when the save was
 * refused. These pin exactly that wiring against a mocked source.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ContactTradeDetailsScreen from '../../app/contact-trade-details';
import { loadTradeDetails, saveTradeDetails } from '../../src/services/trade_details_source';

const back = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back, push: jest.fn() }),
  useLocalSearchParams: () => ({ did: 'did:plc:chairmaker99', name: 'ChairMaker' }),
}));

jest.mock('../../src/services/trade_details_source', () => ({
  loadTradeDetails: jest.fn(),
  saveTradeDetails: jest.fn(),
}));

const loadMock = loadTradeDetails as jest.MockedFunction<typeof loadTradeDetails>;
const saveMock = saveTradeDetails as jest.MockedFunction<typeof saveTradeDetails>;

const GSTIN = '27AAPFU0939F1ZV';

beforeEach(() => {
  jest.clearAllMocks();
  loadMock.mockResolvedValue({
    legalName: '',
    registrations: [],
    billingAddress: null,
    phone: null,
    email: null,
  });
  saveMock.mockResolvedValue([]);
});

describe('the trade-details screen', () => {
  it('shows what is already stated, including the GSTIN and the address', async () => {
    loadMock.mockResolvedValue({
      legalName: 'ChairMaker Industries LLP',
      registrations: [{ scheme: 'gstin', value: GSTIN }],
      billingAddress: { line1: '4 Kalasipalya Road', city: 'Bengaluru', country: 'IN' },
      phone: '+919845012345',
      email: 'sales@chairmaker.example',
    });
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-legalName')).toBeTruthy());
    expect(view.getByTestId('contact-trade-legalName').props.value).toBe('ChairMaker Industries LLP');
    expect(view.getByTestId('contact-trade-gstin').props.value).toBe(GSTIN);
    expect(view.getByTestId('contact-trade-phone').props.value).toBe('+919845012345');
    expect(view.getByTestId('contact-trade-email').props.value).toBe('sales@chairmaker.example');
    expect(view.getByTestId('contact-trade-line1').props.value).toBe('4 Kalasipalya Road');
    expect(view.getByTestId('contact-trade-country').props.value).toBe('IN');
  });

  it('sends what was typed, as the shapes the domain takes, and leaves on success', async () => {
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-save')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('contact-trade-legalName'), 'ChairMaker Industries LLP');
    fireEvent.changeText(view.getByTestId('contact-trade-gstin'), GSTIN);
    fireEvent.changeText(view.getByTestId('contact-trade-phone'), '+91 98450 12345');
    fireEvent.changeText(view.getByTestId('contact-trade-line1'), '4 Kalasipalya Road');
    fireEvent.changeText(view.getByTestId('contact-trade-city'), 'Bengaluru');
    fireEvent.changeText(view.getByTestId('contact-trade-country'), 'IN');
    fireEvent.press(view.getByTestId('contact-trade-save'));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith('did:plc:chairmaker99', {
      legalName: 'ChairMaker Industries LLP',
      registrations: [{ scheme: 'gstin', value: GSTIN }],
      billingAddress: { line1: '4 Kalasipalya Road', city: 'Bengaluru', country: 'IN' },
      phone: '+91 98450 12345',
      email: '',
    });
    await waitFor(() => expect(back).toHaveBeenCalled());
  });

  it('an empty GSTIN clears the registrations rather than sending an empty one', async () => {
    loadMock.mockResolvedValue({
      legalName: '',
      registrations: [{ scheme: 'gstin', value: GSTIN }],
      billingAddress: null,
      phone: null,
      email: null,
    });
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-gstin')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('contact-trade-gstin'), '  ');
    fireEvent.press(view.getByTestId('contact-trade-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][1].registrations).toEqual([]);
  });

  it('an untouched address sends null — there is nothing to state', async () => {
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-save')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('contact-trade-legalName'), 'ChairMaker');
    fireEvent.press(view.getByTestId('contact-trade-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][1].billingAddress).toBeNull();
  });

  it('an address the owner part-typed is SENT, so Core can say what is missing beside the field', async () => {
    saveMock.mockResolvedValue([
      { refusal: 'malformed_address', field: 'billing_address.line1', detail: 'a street line is required' },
    ]);
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-save')).toBeTruthy());
    // Only the PIN code — no street, no city, no country.
    fireEvent.changeText(view.getByTestId('contact-trade-postalCode'), '560002');
    fireEvent.press(view.getByTestId('contact-trade-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][1].billingAddress).toEqual({
      line1: '',
      city: '',
      postalCode: '560002',
      country: '',
    });
    await waitFor(() => expect(view.getByTestId('contact-trade-finding-line1')).toBeTruthy());
  });

  it('a finding that belongs beside NO field is shown in the error slot, never swallowed', async () => {
    saveMock.mockResolvedValue([
      { refusal: 'channel_held_by_another_person', field: 'somewhere_else', detail: 'another contact already has this one' },
    ]);
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-save')).toBeTruthy());
    fireEvent.press(view.getByTestId('contact-trade-save'));
    await waitFor(() => expect(view.getByTestId('contact-trade-error')).toBeTruthy());
    expect(view.getByTestId('contact-trade-error').props.children).toContain('another contact already has this one');
    expect(back).not.toHaveBeenCalled();
  });

  it('shows a refusal beside the field it belongs to, and STAYS on the screen', async () => {
    saveMock.mockResolvedValue([
      { refusal: 'malformed_registration', field: 'registrations[0]', detail: 'the gstin does not pass its own format check' },
      { refusal: 'malformed_channel', field: 'phone', detail: 'a phone must be 8–15 digits, optionally with a leading + country code' },
    ]);
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-save')).toBeTruthy());
    fireEvent.changeText(view.getByTestId('contact-trade-gstin'), '27AAPFU0939F1ZW');
    fireEvent.press(view.getByTestId('contact-trade-save'));

    await waitFor(() => expect(view.getByTestId('contact-trade-finding-gstin')).toBeTruthy());
    expect(view.getByTestId('contact-trade-finding-gstin').props.children).toContain('format check');
    expect(view.getByTestId('contact-trade-finding-phone')).toBeTruthy();
    // A refused save wrote nothing, so the owner stays where their typing is.
    expect(back).not.toHaveBeenCalled();
  });

  it('surfaces a thrown save as an error rather than pretending it saved', async () => {
    saveMock.mockRejectedValue(new Error('core unreachable'));
    const view = render(<ContactTradeDetailsScreen />);
    await waitFor(() => expect(view.getByTestId('contact-trade-save')).toBeTruthy());
    fireEvent.press(view.getByTestId('contact-trade-save'));
    await waitFor(() => expect(view.getByTestId('contact-trade-error')).toBeTruthy());
    expect(back).not.toHaveBeenCalled();
  });
});
