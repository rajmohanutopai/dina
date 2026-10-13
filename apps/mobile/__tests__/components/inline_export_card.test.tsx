/** REAL_LIFE_FIXES_2 §5 — the export card fetches through the owner's device and offers the file. */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { InlineExportCard } from '../../src/components/InlineExportCard';

const mockDispatch = jest.fn();
jest.mock('../../src/services/owner_dispatcher', () => ({ getOwnerDispatcher: () => ({ dispatch: mockDispatch }) }));
const mockShare = jest.fn();
jest.mock('../../src/hooks/useShareExport', () => ({ shareReadableExport: (json: string) => mockShare(json) }));

const message = {
  id: 'm1',
  threadId: 'main',
  type: 'dina',
  content: '',
  timestamp: 1,
  metadata: {
    lifecycle: {
      kind: 'export',
      status: 'ready',
      exportId: 'exp-abc',
      manifest: {
        personas: [
          { persona: 'general', tier: 'default', included: true, items: 12 },
          { persona: 'finance', tier: 'locked', included: false, why: 'locked: unlock finance with your passphrase and ask again', items: 0 },
        ],
        people: 4,
        contacts: 2,
        reminders: 3,
      },
    },
  },
} as never;

beforeEach(() => {
  mockDispatch.mockReset();
  mockShare.mockReset();
});

it('shows what is in it and what is not', () => {
  const screen = render(<InlineExportCard message={message} />);
  expect(screen.getByText('general: 12 notes')).toBeTruthy();
  expect(screen.getByTestId('export-card-excluded-finance')).toBeTruthy();
});

it('fetches the document through the owner device and offers it to save', async () => {
  mockDispatch.mockResolvedValue({ status: 200, body: { vault: { general: [] } } });
  mockShare.mockResolvedValue('shared');
  const screen = render(<InlineExportCard message={message} />);
  fireEvent.press(screen.getByTestId('export-card-save-exp-abc'));
  await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  expect(mockDispatch).toHaveBeenCalledWith({ method: 'GET', path: '/v1/owner-export/exp-abc' });
  expect(mockShare.mock.calls[0][0]).toContain('"vault"');
});

it('an expired export says so', async () => {
  mockDispatch.mockResolvedValue({ status: 404, body: {} });
  const screen = render(<InlineExportCard message={message} />);
  fireEvent.press(screen.getByTestId('export-card-save-exp-abc'));
  await waitFor(() => expect(screen.getByText('Expired: ask again')).toBeTruthy());
});
