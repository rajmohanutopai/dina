/**
 * COMMITMENT_KERNEL §11, "The disclosure rules" (step 2 of §15).
 *
 *   D-01  per-category sharing tiers survive a restart;
 *   D-02  a contact on `eta_only` receives no pincode, before and after a
 *         restart; `pincode_only` admits a pincode and nothing finer, and
 *         filters a payload down to it;
 *   D-03  no existing tier changes meaning: summary and full still admit a
 *         general or health field; a location line needs full or exact_location;
 *   D-04  at the outbound gate, `pincode_only` lets no free text through: a
 *         line about a place cannot be cut down to a pincode.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { fieldAdmitted } from '../../src/commitment';
import { tierAdmitsDisclosure } from '../../src/coordination/disclosure_policy';
import { checkEgress } from '../../src/gatekeeper/egress';
import {
  clearSharingPolicies,
  filterByTier,
  getSharingPolicy,
  installSharingPolicyStore,
  setSharingPolicy,
} from '../../src/gatekeeper/sharing';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const ALICE = 'did:plc:alice00000000000000000000';
const BOB = 'did:plc:bob0000000000000000000000';
const PINCODE = { category: 'location', grain: 'pincode' } as const;
const ADDRESS = { category: 'location', grain: 'address' } as const;

describe('sharing tiers and the disclosure rules', () => {
  let dir: string;
  let file: string;
  let pass: string;
  let db: NodeSQLiteAdapter;

  const open = (fresh: boolean): NodeSQLiteAdapter => {
    const adapter = new NodeSQLiteAdapter({
      path: file,
      passphraseHex: pass,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    if (fresh) applyMigrations(adapter, IDENTITY_MIGRATIONS);
    return adapter;
  };
  /** An app relaunch: memory gone, the file stays, the store is installed at boot. */
  const restart = (): void => {
    db.close();
    clearSharingPolicies();
    db = open(false);
    installSharingPolicyStore(db);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-sharing-'));
    file = path.join(dir, 'identity.sqlite');
    pass = randomBytes(32).toString('hex');
    db = open(true);
    clearSharingPolicies();
    installSharingPolicyStore(db);
  });
  afterEach(() => {
    clearSharingPolicies();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('D-01: per-category tiers survive a restart', () => {
    setSharingPolicy(ALICE, 'health', 'summary');
    setSharingPolicy(ALICE, 'location', 'pincode_only');
    restart();
    expect(getSharingPolicy(ALICE, 'health')).toBe('summary');
    expect(getSharingPolicy(ALICE, 'location')).toBe('pincode_only');
    expect(getSharingPolicy(BOB, 'location')).toBeUndefined();
  });

  it('D-02: eta_only gives no pincode, through a restart; pincode_only gives a pincode only', () => {
    setSharingPolicy(BOB, 'location', 'eta_only');
    setSharingPolicy(ALICE, 'location', 'pincode_only');
    for (const when of ['before', 'after'] as const) {
      if (when === 'after') restart();
      expect([when, fieldAdmitted(getSharingPolicy(BOB, 'location'), PINCODE)]).toEqual([
        when,
        false,
      ]);
      expect([when, fieldAdmitted(getSharingPolicy(ALICE, 'location'), PINCODE)]).toEqual([
        when,
        true,
      ]);
      expect([when, fieldAdmitted(getSharingPolicy(ALICE, 'location'), ADDRESS)]).toEqual([
        when,
        false,
      ]);
    }
    expect(fieldAdmitted(undefined, PINCODE)).toBe(false);
    expect(
      filterByTier(
        { id: 'p1', type: 'place', pincode: '560034', address: '12 MG Road' },
        'pincode_only',
      ),
    ).toEqual({ id: 'p1', type: 'place', pincode: '560034' });
    expect(filterByTier({ eta: '10:00', pincode: '560034' }, 'eta_only')).toEqual({ eta: '10:00' });
  });

  it('D-03: no existing tier changes meaning', () => {
    for (const tier of ['summary', 'full'] as const) {
      expect(fieldAdmitted(tier, { category: 'health' })).toBe(true);
      expect(tierAdmitsDisclosure(tier)).toBe(true);
    }
    for (const tier of ['eta_only', 'free_busy', 'pincode_only', 'none', 'locked'] as const)
      expect([tier, tierAdmitsDisclosure(tier)]).toEqual([tier, false]);
    expect(fieldAdmitted('exact_location', ADDRESS)).toBe(true);
    expect(tierAdmitsDisclosure('summary', 'location')).toBe(false);
    expect(tierAdmitsDisclosure('exact_location', 'location')).toBe(true);
  });

  it('D-04: the outbound gate refuses free text under pincode_only', () => {
    setSharingPolicy(ALICE, 'location', 'pincode_only');
    const out = checkEgress(
      { text: 'We are at 12.9716, 77.5946, 12 MG Road', categories: ['location'] },
      ALICE,
    );
    expect(out).toMatchObject({ allowed: false, filteredText: '', appliedTier: 'pincode_only' });
    setSharingPolicy(ALICE, 'location', 'exact_location');
    expect(checkEgress({ text: 'At the shop', categories: ['location'] }, ALICE).allowed).toBe(
      true,
    );
  });
});
