/**
 * The phone's backup (docs/USER_BACKUP.md §4.4–§4.6): on by default once the
 * phrase is confirmed, and recovery finding a copy with the 24 words alone.
 * The store's own rules are tested against the real service in
 * `apps/backup-service`; here a small fake answers the same routes.
 */

import {
  deriveBackupIdentity,
  kvBackupStore,
  mnemonicToEntropy,
  sealBackup,
  type ArchivePayloadV1,
} from '@dina/core';

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { generateNewMnemonic } from '../../src/hooks/useOnboarding';
import {
  backupStoreUrl,
  findBackupForPhrase,
  isBackupEnabled,
  setBackupEnabled,
} from '../../src/services/cloud_backup';
import { markVerificationPending, markVerified } from '../../src/services/verification_status';

const EMPTY: ArchivePayloadV1 = {
  header: {
    format: 'dina-archive-v1',
    version: 1,
    created_at: 1,
    app_version: 'test',
    schema_versions: {},
    persona_count: 0,
    checksums: {},
  },
  identity: { tables: {} },
  personas: [],
};

const realFetch = globalThis.fetch;

/** Serves `latest` from one stored copy per backup id, as the store would. */
function serveCopies(copies: Map<string, Uint8Array>): void {
  globalThis.fetch = (async (url: string) => {
    const m = /\/v1\/backups\/([0-9a-f]{64})\/latest$/.exec(String(url));
    const bytes = m !== null ? copies.get(m[1] ?? '') : undefined;
    return {
      status: bytes === undefined ? 404 : 200,
      arrayBuffer: async () => (bytes ?? new Uint8Array()).slice().buffer,
      text: async () => (bytes === undefined ? '{"error":"not_found"}' : ''),
    };
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  resetKeychainMock();
  await kvBackupStore.set('enabled', '');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('backup switch', () => {
  it('is on once the phrase is confirmed, and off while it is not', async () => {
    await markVerified();
    expect(await isBackupEnabled()).toBe(true);
    await markVerificationPending();
    expect(await isBackupEnabled()).toBe(false);
  });

  it('the owner’s choice wins either way', async () => {
    await markVerified();
    await setBackupEnabled(false);
    expect(await isBackupEnabled()).toBe(false);
    await markVerificationPending();
    await setBackupEnabled(true);
    expect(await isBackupEnabled()).toBe(true);
  });

  it('copies go to the test store unless the build says otherwise', () => {
    expect(backupStoreUrl()).toBe('https://test-backup.dinakernel.com');
  });
});

describe('recovery finds a copy with the 24 words alone', () => {
  it('opens the newest copy and reads the handle from inside it', async () => {
    const mnemonic = generateNewMnemonic();
    const id = deriveBackupIdentity(mnemonicToEntropy(mnemonic.join(' ')));
    const copies = new Map([
      [
        id.backupId,
        sealBackup(EMPTY, id, {
          did: 'did:plc:alonso',
          handle: 'alonso77.test-pds.dinakernel.com',
          counter: 4,
          createdAt: 1_759_500_000_000,
        }),
      ],
    ]);
    serveCopies(copies);
    const hit = await findBackupForPhrase(mnemonic);
    expect(hit?.found.meta).toMatchObject({
      did: 'did:plc:alonso',
      handle: 'alonso77.test-pds.dinakernel.com',
      counter: 4,
      created_at: 1_759_500_000_000,
    });
  });

  it('finds nothing for other words, or with the store out of reach', async () => {
    serveCopies(new Map());
    expect(await findBackupForPhrase(generateNewMnemonic())).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await findBackupForPhrase(generateNewMnemonic())).toBeNull();
  });
});
