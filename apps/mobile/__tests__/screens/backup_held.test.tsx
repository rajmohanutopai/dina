/**
 * The Backup screen when the daily run is holding for the owner (BACKUP-1,
 * PH-03): it says so, and offers the two ways out.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import BackupScreen from '../../app/backup';
import * as cloud from '../../src/services/cloud_backup';
import { reloadApp } from '../../src/services/reload_app';

jest.mock('../../src/services/reload_app', () => ({ reloadApp: jest.fn(async () => undefined) }));
jest.mock('../../src/services/cloud_backup', () => ({
  backupStatus: jest.fn(),
  backUpNowFromSettings: jest.fn(async () => ({ storeBehind: false })),
  deleteAllBackups: jest.fn(async () => undefined),
  restoreNewestBackupFromSettings: jest.fn(async () => undefined),
  setBackupEnabled: jest.fn(async () => undefined),
}));

function status(heldForOwner: boolean): void {
  (cloud.backupStatus as jest.Mock).mockResolvedValue({
    enabled: true,
    lastAt: null,
    storeUrl: 'https://store.test',
    heldForOwner,
  });
}

beforeEach(() => jest.clearAllMocks());

it('shows nothing extra when nothing is held', async () => {
  status(false);
  const view = render(<BackupScreen />);
  await waitFor(() => expect(view.getByTestId('backup-now')).toBeTruthy());
  expect(view.queryByTestId('backup-held')).toBeNull();
});

it('restore brings the copy back and reloads the app', async () => {
  status(true);
  const view = render(<BackupScreen />);
  await waitFor(() => expect(view.getByTestId('backup-held')).toBeTruthy());
  fireEvent.press(view.getByTestId('backup-held-restore'));
  await waitFor(() => expect(reloadApp).toHaveBeenCalled());
  expect(cloud.restoreNewestBackupFromSettings).toHaveBeenCalledTimes(1);
});

it('"Back up now" asks once more first: it makes this phone the newest copy', async () => {
  status(true);
  const view = render(<BackupScreen />);
  await waitFor(() => expect(view.getByTestId('backup-held')).toBeTruthy());
  fireEvent.press(view.getByTestId('backup-now'));
  await waitFor(() => expect(view.getByText('Tap again to start fresh')).toBeTruthy());
  expect(cloud.backUpNowFromSettings).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('backup-now'));
  await waitFor(() => expect(cloud.backUpNowFromSettings).toHaveBeenCalledTimes(1));
});
