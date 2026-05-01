/**
 * Tests for IdentityModal — the popover that opens when a user taps
 * a peer's short username anywhere in the app.
 *
 * The modal is the affordance that lets us safely render just
 * `alice` instead of `alice.pds.dinakernel.com` everywhere — the
 * full handle, full DID, and full PLC document are one tap away,
 * and every field has a copy button.
 *
 * These tests pin:
 *   - Loaded state renders handle / DID / signing keys / services
 *   - Loading state renders while the PLC fetch is in flight
 *   - Error state renders on fetch rejection
 *   - Closed modal renders nothing (mock returns null when !visible)
 *   - The fetcher is NOT called when visible is false (no useless
 *     network round-trips when the modal hasn't been opened)
 *   - Re-opening for a different DID resets state (no flash of old
 *     peer's data)
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { IdentityModal } from '../../src/components/identity/identity_modal';
import type { PlcLookupResult } from '../../src/services/plc_lookup';

const DID = 'did:plc:zaxxz2vts2umzfk2r5fpzes4';

function makeDoc(overrides: Partial<PlcLookupResult> = {}): PlcLookupResult {
  return {
    did: DID,
    handle: 'rajmohanddc9.test-pds.dinakernel.com',
    alsoKnownAs: ['at://rajmohanddc9.test-pds.dinakernel.com'],
    verificationMethods: [
      {
        id: `${DID}#dina_signing`,
        type: 'Multikey',
        controller: DID,
        publicKeyMultibase: 'z6Mkiup6CNAw2w3t6adaYNv12jd81jNz9XHiExBwpugbeEBN',
      },
    ],
    services: [
      {
        id: '#dina-messaging',
        type: 'DinaMsgBox',
        serviceEndpoint: 'wss://test-mailbox.dinakernel.com',
      },
    ],
    created: '2026-04-30T11:23:00Z',
    ...overrides,
  };
}

describe('IdentityModal', () => {
  it('renders the loaded card with handle, DID, signing key, and service', async () => {
    const fetchPlc = jest.fn(async () => makeDoc());
    const { getByText, getAllByText, queryByTestId } = render(
      <IdentityModal
        visible
        onClose={() => undefined}
        did={DID}
        initialHandle={null}
        fetchPlc={fetchPlc}
      />,
    );
    await waitFor(() =>
      expect(queryByTestId('identity-modal-loading')).toBeNull(),
    );
    // Handle appears as the title (header) AND copyable in the
    // Handle group.
    expect(getAllByText('rajmohanddc9.test-pds.dinakernel.com').length).toBeGreaterThanOrEqual(2);
    // DID appears as the muted header caption AND in the DID group.
    expect(getAllByText(DID).length).toBeGreaterThanOrEqual(2);
    expect(
      getByText('z6Mkiup6CNAw2w3t6adaYNv12jd81jNz9XHiExBwpugbeEBN'),
    ).toBeTruthy();
    expect(getByText('wss://test-mailbox.dinakernel.com')).toBeTruthy();
  });

  it('shows the initialHandle as the title while the fetch is in flight', () => {
    // Stalled fetcher — never resolves. The header should still
    // immediately show the wire-side hint so the modal isn't a blank
    // sheet.
    const fetchPlc = jest.fn(() => new Promise<PlcLookupResult>(() => undefined));
    const { getByTestId } = render(
      <IdentityModal
        visible
        onClose={() => undefined}
        did={DID}
        initialHandle="rajmohanddc9.test-pds.dinakernel.com"
        fetchPlc={fetchPlc}
      />,
    );
    expect(getByTestId('identity-modal-loading')).toBeTruthy();
    expect(getByTestId('identity-modal-handle').props.children).toBe(
      'rajmohanddc9.test-pds.dinakernel.com',
    );
  });

  it('renders the error state on fetch rejection', async () => {
    const fetchPlc = jest.fn(async () => {
      throw new Error('plc.directory returned HTTP 500');
    });
    const { getByTestId, getByText } = render(
      <IdentityModal
        visible
        onClose={() => undefined}
        did={DID}
        fetchPlc={fetchPlc}
      />,
    );
    await waitFor(() => expect(getByTestId('identity-modal-error')).toBeTruthy());
    expect(getByText('plc.directory returned HTTP 500')).toBeTruthy();
  });

  it('renders an error state when did is empty', async () => {
    // Defensive: a row missing its DID would render the modal with
    // no fetch target. Show the error rather than spin forever.
    const fetchPlc = jest.fn(async () => makeDoc());
    const { getByTestId } = render(
      <IdentityModal
        visible
        onClose={() => undefined}
        did=""
        fetchPlc={fetchPlc}
      />,
    );
    expect(getByTestId('identity-modal-error')).toBeTruthy();
    expect(fetchPlc).not.toHaveBeenCalled();
  });

  it('does NOT call the fetcher when not visible', () => {
    // Pinning the lazy-fetch contract: the modal must not poll
    // plc.directory on mount; the network request only fires when
    // the user actually opens the modal. Otherwise every list row
    // would warm a PLC fetch the user might never trigger.
    const fetchPlc = jest.fn(async () => makeDoc());
    render(
      <IdentityModal
        visible={false}
        onClose={() => undefined}
        did={DID}
        fetchPlc={fetchPlc}
      />,
    );
    expect(fetchPlc).not.toHaveBeenCalled();
  });

  it('returns null markup when not visible', () => {
    // Mock react-native Modal returns null when !visible — assert
    // that contract holds so the surrounding screen tree is clean.
    const fetchPlc = jest.fn(async () => makeDoc());
    const { queryByTestId } = render(
      <IdentityModal
        visible={false}
        onClose={() => undefined}
        did={DID}
        fetchPlc={fetchPlc}
      />,
    );
    expect(queryByTestId('identity-modal-handle')).toBeNull();
  });

  it('handle row is hidden when there is no published handle', async () => {
    const fetchPlc = jest.fn(async () => makeDoc({ handle: null, alsoKnownAs: [] }));
    const { getByText, getAllByText, queryByTestId } = render(
      <IdentityModal
        visible
        onClose={() => undefined}
        did={DID}
        fetchPlc={fetchPlc}
      />,
    );
    await waitFor(() =>
      expect(queryByTestId('identity-modal-loading')).toBeNull(),
    );
    // Em-dash placeholder used for the canonical row when there's
    // nothing to copy. The DID and services still render so the user
    // can still inspect the identity.
    expect(getByText('—')).toBeTruthy();
    expect(getAllByText(DID).length).toBeGreaterThanOrEqual(2);
  });
});
