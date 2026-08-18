/**
 * Staff grants and the §6.5 threshold gate (TRADE_FIRST_STRATEGY §6):
 * repository discipline on both backends, grant-input validation, the
 * deterministic allow/refuse/escalate verdicts, attributed presence
 * (per-device stamps, TTL, fail-closed proving), and the escalation's
 * idempotent owner approval task.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  clearOwnerPresence,
  clearStaffPresence,
  installStaffPresenceVerifier,
  OWNER_PRESENCE_TTL_MS,
  proveStaffPresence,
  staffPresenceCanBeEstablished,
  staffPresentNow,
} from '../../src/commerce/owner_presence';
import {
  escalateStaffOperation,
  STAFF_ESCALATION_APPROVAL_TYPE,
} from '../../src/commerce/staff_escalation';
import {
  checkStaffOperation,
  InMemoryStaffGrantRepository,
  SQLiteStaffGrantRepository,
  validateStaffGrantInput,
  type StaffGrant,
  type StaffGrantRepository,
} from '../../src/commerce/staff_grants';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const DEVICE = 'did:key:staffclerk';
const T0 = 1_800_000_000_000;

function grant(overrides: Partial<StaffGrant> = {}): StaffGrant {
  return {
    deviceDid: DEVICE,
    scope: 'commerce_receive_goods',
    maxOrderMinorUnits: '30000',
    currency: 'INR',
    installs: 'buyer',
    createdAt: T0,
    revokedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Repository — both backends, one body
// ---------------------------------------------------------------------------

interface Backend {
  name: string;
  make: () => { repo: StaffGrantRepository; close: () => void };
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-staff-grants-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteStaffGrantRepository(adapter),
        close: () => {
          adapter.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'memory',
    make: () => ({ repo: new InMemoryStaffGrantRepository(), close: () => undefined }),
  },
];

describe.each(backends)('staff grant repository ($name)', ({ make }) => {
  let repo: StaffGrantRepository;
  let close: () => void;

  beforeEach(() => {
    ({ repo, close } = make());
  });
  afterEach(() => close());

  it('round-trips a grant and replaces on (device, scope)', () => {
    repo.put(grant());
    expect(repo.get(DEVICE, 'commerce_receive_goods')).toEqual(grant());
    repo.put(grant({ maxOrderMinorUnits: '50000' }));
    expect(repo.get(DEVICE, 'commerce_receive_goods')?.maxOrderMinorUnits).toBe('50000');
    expect(repo.listByDevice(DEVICE)).toHaveLength(1);
  });

  it('lists per device, sorted by scope', () => {
    repo.put(grant({ scope: 'commerce_submit' }));
    repo.put(grant({ scope: 'commerce_confirm', maxOrderMinorUnits: '', currency: '' }));
    repo.put(grant({ deviceDid: 'did:key:other', scope: 'commerce_confirm', maxOrderMinorUnits: '', currency: '' }));
    expect(repo.listByDevice(DEVICE).map((g) => g.scope)).toEqual([
      'commerce_confirm',
      'commerce_submit',
    ]);
  });

  it('revokeDevice stamps every live grant of THAT device only', () => {
    repo.put(grant({ scope: 'commerce_submit' }));
    repo.put(grant({ scope: 'commerce_receive_goods' }));
    repo.put(grant({ deviceDid: 'did:key:other' }));
    repo.revokeDevice(DEVICE, T0 + 5);
    expect(repo.listByDevice(DEVICE).every((g) => g.revokedAt === T0 + 5)).toBe(true);
    expect(repo.get('did:key:other', 'commerce_receive_goods')?.revokedAt).toBeNull();
    // A second revoke does not re-stamp the already-revoked rows.
    repo.revokeDevice(DEVICE, T0 + 99);
    expect(repo.listByDevice(DEVICE).every((g) => g.revokedAt === T0 + 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Grant-input validation (the owner ceremony's shape check)
// ---------------------------------------------------------------------------

describe('validateStaffGrantInput', () => {
  it('a capped scope requires cap and currency, well-formed', () => {
    expect(
      validateStaffGrantInput({ scope: 'commerce_submit', installs: 'buyer' }),
    ).toContain('requires');
    expect(
      validateStaffGrantInput({
        scope: 'commerce_submit',
        installs: 'buyer',
        maxOrderMinorUnits: '-5',
        currency: 'INR',
      }),
    ).not.toBeNull();
    expect(
      validateStaffGrantInput({
        scope: 'commerce_submit',
        installs: 'buyer',
        maxOrderMinorUnits: '30000',
        currency: 'INR',
      }),
    ).toBeNull();
  });

  it('commerce_confirm refuses any cap — money control lives at submit', () => {
    expect(
      validateStaffGrantInput({
        scope: 'commerce_confirm',
        installs: 'both',
        maxOrderMinorUnits: '1',
        currency: 'INR',
      }),
    ).toContain('no cap');
    expect(validateStaffGrantInput({ scope: 'commerce_confirm', installs: 'both' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gate (§6.5)
// ---------------------------------------------------------------------------

describe('checkStaffOperation', () => {
  let repo: InMemoryStaffGrantRepository;
  beforeEach(() => {
    repo = new InMemoryStaffGrantRepository();
  });

  const check = (value?: { currency: string; minor_units: string }) =>
    checkStaffOperation({
      repository: repo,
      deviceDid: DEVICE,
      scope: 'commerce_receive_goods',
      installRole: 'buyer',
      ...(value === undefined ? {} : { value }),
    });

  it('refuses with no grant, and with a revoked one', () => {
    expect(check({ currency: 'INR', minor_units: '100' }).verdict).toBe('refuse');
    repo.put(grant({ revokedAt: T0 }));
    expect(check({ currency: 'INR', minor_units: '100' }).verdict).toBe('refuse');
  });

  it('refuses across the install-role boundary; both covers either side', () => {
    repo.put(grant({ installs: 'supplier' }));
    expect(check({ currency: 'INR', minor_units: '100' }).verdict).toBe('refuse');
    repo.put(grant({ installs: 'both' }));
    expect(check({ currency: 'INR', minor_units: '100' }).verdict).toBe('allow');
  });

  it('commerce_confirm allows on scope + install role alone — no value exists yet', () => {
    repo.put(grant({ scope: 'commerce_confirm', maxOrderMinorUnits: '', currency: '' }));
    expect(
      checkStaffOperation({
        repository: repo,
        deviceDid: DEVICE,
        scope: 'commerce_confirm',
        installRole: 'buyer',
      }).verdict,
    ).toBe('allow');
  });

  it('a capped scope with NO computable value escalates — omission never slips under the cap', () => {
    repo.put(grant());
    expect(check().verdict).toBe('escalate');
  });

  it('escalates off-currency and above the cap; allows at the cap exactly', () => {
    repo.put(grant()); // cap 30000 INR
    expect(check({ currency: 'USD', minor_units: '1' }).verdict).toBe('escalate');
    expect(check({ currency: 'INR', minor_units: '30001' }).verdict).toBe('escalate');
    expect(check({ currency: 'INR', minor_units: '30000' }).verdict).toBe('allow');
  });

  it('refuses a malformed value outright', () => {
    repo.put(grant());
    expect(check({ currency: 'INR', minor_units: 'abc' }).verdict).toBe('refuse');
  });
});

// ---------------------------------------------------------------------------
// Attributed presence (§6.4)
// ---------------------------------------------------------------------------

describe('staff presence', () => {
  afterEach(() => {
    installStaffPresenceVerifier(null);
    clearOwnerPresence();
  });

  it('fails closed: no verifier, empty inputs, throwing verifier', async () => {
    expect(staffPresenceCanBeEstablished()).toBe(false);
    expect(await proveStaffPresence(DEVICE, '1234', T0)).toBe(false);
    installStaffPresenceVerifier(async () => {
      throw new Error('argon backend down');
    });
    expect(staffPresenceCanBeEstablished()).toBe(true);
    expect(await proveStaffPresence(DEVICE, '1234', T0)).toBe(false);
    installStaffPresenceVerifier(async () => true);
    expect(await proveStaffPresence('', '1234', T0)).toBe(false);
    expect(await proveStaffPresence(DEVICE, '', T0)).toBe(false);
    expect(staffPresentNow(DEVICE, T0)).toBe(false);
  });

  it('stamps PER DEVICE with the owner TTL; a future stamp reads absent', async () => {
    installStaffPresenceVerifier(async (deviceDid, pin) => pin === `pin-${deviceDid.slice(-1)}`);
    expect(await proveStaffPresence('did:key:a', 'pin-a', T0)).toBe(true);
    expect(await proveStaffPresence('did:key:b', 'wrong', T0)).toBe(false);
    expect(staffPresentNow('did:key:a', T0 + OWNER_PRESENCE_TTL_MS - 1)).toBe(true);
    expect(staffPresentNow('did:key:a', T0 + OWNER_PRESENCE_TTL_MS)).toBe(false);
    expect(staffPresentNow('did:key:b', T0)).toBe(false);
    // Clock moved backwards under the stamp: no proof.
    expect(staffPresentNow('did:key:a', T0 - 1)).toBe(false);
  });

  it('verifier swap, per-device clear, and the owner clear all drop stamps', async () => {
    installStaffPresenceVerifier(async () => true);
    await proveStaffPresence('did:key:a', 'x', T0);
    await proveStaffPresence('did:key:b', 'x', T0);
    clearStaffPresence('did:key:a');
    expect(staffPresentNow('did:key:a', T0)).toBe(false);
    expect(staffPresentNow('did:key:b', T0)).toBe(true);
    installStaffPresenceVerifier(async () => true);
    expect(staffPresentNow('did:key:b', T0)).toBe(false);
    await proveStaffPresence('did:key:b', 'x', T0);
    clearOwnerPresence();
    expect(staffPresentNow('did:key:b', T0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escalation (§6.5's "escalate = owner approval task")
// ---------------------------------------------------------------------------

describe('escalateStaffOperation', () => {
  afterEach(() => setWorkflowService(null));

  it('fails closed with no workflow service', () => {
    expect(
      escalateStaffOperation({
        deviceDid: DEVICE,
        scope: 'commerce_receive_goods',
        subject: 'note-digest',
        value: { currency: 'INR', minor_units: '80000' },
        reason: 'value exceeds the grant cap',
        nowMs: T0,
      }).kind,
    ).toBe('unavailable');
  });

  it('creates ONE pending-approval task per (device, scope, subject, VALUE); the card carries no lines', () => {
    const repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
    const escalate = (minorUnits: string, nowMs: number) =>
      escalateStaffOperation({
        deviceDid: DEVICE,
        scope: 'commerce_receive_goods',
        subject: 'note-digest',
        value: { currency: 'INR', minor_units: minorUnits },
        reason: 'value exceeds the grant cap',
        nowMs,
      });
    const first = escalate('80000', T0);
    const again = escalate('80000', T0 + 1);
    expect(first.kind).toBe('escalated');
    expect(again).toEqual(first);
    // A different value is a different question — its own card.
    const other = escalate('90000', T0 + 2);
    expect(other.kind).toBe('escalated');
    expect(other).not.toEqual(first);
    const tasks = repo.listByKindAndState('approval', WorkflowTaskState.PendingApproval, 100);
    expect(tasks).toHaveLength(2);
    const payload = JSON.parse(tasks[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.type).toBe(STAFF_ESCALATION_APPROVAL_TYPE);
    expect(payload.device_did).toBe(DEVICE);
    expect(payload.value).toEqual({ currency: 'INR', minor_units: '80000' });
    expect(payload).not.toHaveProperty('lines');
  });

  it("reads an approved card back as 'approved' — the owner's yes reaches the retry", () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({ repository: repo });
    setWorkflowService(service);
    const args = {
      deviceDid: DEVICE,
      scope: 'commerce_receive_goods' as const,
      subject: 'note-digest',
      value: { currency: 'INR', minor_units: '80000' },
      reason: 'value exceeds the grant cap',
      nowMs: T0,
    };
    const card = escalateStaffOperation(args);
    if (card.kind !== 'escalated') throw new Error('expected a card');
    service.approve(card.taskId);
    expect(escalateStaffOperation({ ...args, nowMs: T0 + 1 })).toEqual({
      kind: 'approved',
      taskId: card.taskId,
    });
  });
});
