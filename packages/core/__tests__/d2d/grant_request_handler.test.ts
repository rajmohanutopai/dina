/**
 * handleServiceGrantRequest() — the contact-service grant-request handler
 * (docs/CONTACT_SERVICES_ARCHITECTURE.md §5.2). Pins the wiring of the reviewed
 * pure pieces (closeness × default-offerable policy) to the real grant
 * materialization + offer delivery:
 *   - close + default-offerable  → mint grant + send service.offer (auto_grant)
 *   - distant                    → no grant, no offer (soft_reject)
 *   - friend (medium)            → no grant, no offer (ask_to_enable, pending UI)
 *   - close + NOT default-offerable → no grant (master-gate)
 *   - no talk listing for the cap  → no grant
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations, IDENTITY_MIGRATIONS } from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetAuditState } from '../../src/audit/service';
import {
  establishContact,
  resetContactDirectory,
  type Relationship,
  type TrustLevel,
} from '../../src/contacts/directory';
import { SQLiteContactRepository, setContactRepository } from '../../src/contacts/repository';
import {
  SQLiteServiceDecisionRepository,
  setServiceDecisionRepository,
  getServiceDecisionRepository,
} from '../../src/contacts/service_decisions_repository';
import { clearGatesState } from '../../src/d2d/gates';
import {
  onGrantRequestPending,
  resetGrantRequestPendingListeners,
  type GrantRequestPendingEvent,
} from '../../src/d2d/grant_request_events';
import { handleServiceGrantRequest } from '../../src/d2d/grant_request_handler';
import { setNodeDID } from '../../src/pairing/ceremony';
import {
  SQLitePeopleRepository,
  setPeopleRepository,
  getPeopleRepository,
} from '../../src/people/repository';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import {
  setServiceConfig,
  resetServiceConfigState,
} from '../../src/service/service_config';
import {
  setServiceGrantRepository,
  type ServiceGrant,
} from '../../src/service/service_grant_repository';

const REQUESTER = 'did:plc:alonso';
const PROVIDER = 'did:plc:sancho';
const CAP = 'availability_coordination';

let adapter: NodeSQLiteAdapter;
let dbDir = '';
const created: ServiceGrant[] = [];
const sent: { to: string; type: string; body: Record<string, unknown> }[] = [];
const pendingEvents: GrantRequestPendingEvent[] = [];

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-grant-req-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dbDir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPeopleRepository(new SQLitePeopleRepository(adapter));
  setContactRepository(new SQLiteContactRepository(adapter));
  setServiceDecisionRepository(new SQLiteServiceDecisionRepository(adapter));
});

afterAll(() => {
  setPeopleRepository(null);
  setContactRepository(null);
  setServiceDecisionRepository(null);
  try {
    adapter.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// The identity DB persists across tests (opened once in beforeAll); clear the
// contact/people tables each test so `getContact`'s SQL fallback starts clean.
const IDENTITY_TABLES = [
  'contact_aliases',
  'contacts',
  'person_surfaces',
  'person_identities',
  'person_extraction_log',
  'people',
  'contact_service_decisions',
];

beforeEach(() => {
  for (const t of IDENTITY_TABLES) {
    try {
      adapter.execute(`DELETE FROM ${t}`);
    } catch {
      /* table may be absent in this migration set */
    }
  }
  resetContactDirectory();
  clearGatesState();
  resetServiceConfigState();
  resetAuditState();
  // The provider identity is the node's own DID (confused-deputy fix): the
  // handler derives selfDID from getNodeDID(), never from the wire.
  setNodeDID(PROVIDER);
  created.length = 0;
  sent.length = 0;
  pendingEvents.length = 0;
  resetGrantRequestPendingListeners();
  onGrantRequestPending((e) => pendingEvents.push(e));
  setServiceGrantRepository({
    create: (g) => {
      created.push(g);
    },
    getById: () => null,
    isAuthorized: () => false,
    listByGrantee: () => [],
    revoke: () => true,
  });
  setD2DSender(async (to, type, body) => {
    sent.push({ to, type, body });
  });
});

afterEach(() => {
  setServiceGrantRepository(null);
  setD2DSender(null);
  resetGrantRequestPendingListeners();
  // node DID is re-set in beforeEach; jest isolates modules per file, so no
  // cross-file leak — nothing to reset here.
});

/** A talk-surface listing offering availability_coordination. */
function talkListing(defaultOfferable: boolean): void {
  setServiceConfig(
    {
      name: 'My availability',
      isDiscoverable: false,
      discoverability: 'known_only',
      surface: 'talk',
      defaultOfferable,
      status: 'active',
      capabilities: {
        [CAP]: { instruction: 'coordinate a meeting time', responsePolicy: 'review' },
      },
    },
    'avail-1',
  );
}

function contact(relationship: Relationship, trustLevel: TrustLevel = 'verified'): void {
  establishContact(REQUESTER, 'Alonso', { relationship, trustLevel });
}

const request = {
  request_id: 'req-1',
  capability: CAP,
  intent: 'find a time next week',
  requested_surface: 'talk' as const,
};

describe('handleServiceGrantRequest — auto_grant (close + default-offerable)', () => {
  it('mints a grant + sends a service.offer carrying grant_id + service_uri', async () => {
    contact('spouse');
    talkListing(true);

    await handleServiceGrantRequest(REQUESTER, request);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ granteeDid: REQUESTER, serviceRkey: 'avail-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(REQUESTER);
    expect(sent[0].type).toBe('service.offer');
    expect(sent[0].body.grant_id).toBe(created[0].grantId);
    expect(sent[0].body.service_uri).toBe(
      `at://${PROVIDER}/com.dinakernel.service.profile/avail-1`,
    );
    // The offer echoes the originating request_id so the requester can correlate
    // + auto-replay exactly that request (review #1).
    expect(sent[0].body.request_id).toBe('req-1');
    // auto_grant mints directly — no owner prompt needed, so no pending event.
    expect(pendingEvents).toHaveLength(0);
  });

  it('multi-listing tiebreak: binds the DEFAULT-OFFERABLE listing, not first-by-rkey (#6)', async () => {
    contact('spouse');
    // Two talk listings for the SAME capability: the earlier rkey is NOT
    // default-offerable; the later one is. The arbitrary "first by rkey" would
    // pick avail-1 (and soft-reject, since it's not offerable); the deterministic
    // tiebreak must pick avail-2 — the listing the owner marked auto-grantable.
    setServiceConfig(
      {
        name: 'Personal availability',
        isDiscoverable: false,
        discoverability: 'known_only',
        surface: 'talk',
        defaultOfferable: false,
        status: 'active',
        capabilities: { [CAP]: { instruction: 'x', responsePolicy: 'review' } },
      },
      'avail-1',
    );
    setServiceConfig(
      {
        name: 'Salon availability',
        isDiscoverable: false,
        discoverability: 'known_only',
        surface: 'talk',
        defaultOfferable: true,
        status: 'active',
        capabilities: { [CAP]: { instruction: 'x', responsePolicy: 'review' } },
      },
      'avail-2',
    );

    await handleServiceGrantRequest(REQUESTER, request);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ granteeDid: REQUESTER, serviceRkey: 'avail-2' });
  });
});

describe('handleServiceGrantRequest — non-auto tiers never mint or offer', () => {
  it('distant (acquaintance) → soft_reject: no grant, no offer, NO prompt', async () => {
    contact('acquaintance');
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // soft_reject must NOT surface a prompt — a refusal can't leak (spec §2).
    expect(pendingEvents).toHaveLength(0);
  });

  it('friend (medium) → ask_to_enable: emits a pending event for the Talk prompt (no grant/offer)', async () => {
    contact('friend');
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    // Core decided REACH but does NOT mint — the owner's yes is the gate.
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // ...and it emits the pending-decision event the mobile boot consumes to
    // post the "Allow <contact>?" prompt, carrying the selectors the eventual
    // offer needs (requester DID + capability + resolved listing rkey).
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]).toMatchObject({
      requesterDID: REQUESTER,
      capability: CAP,
      rkey: 'avail-1',
      closeness: 'medium',
    });
  });

  it('close but listing NOT default-offerable → soft_reject (master gate)', async () => {
    contact('spouse');
    talkListing(false);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('no talk listing offers the capability → no grant, no offer', async () => {
    contact('spouse');
    // a services-surface listing with the cap must NOT satisfy a talk request
    setServiceConfig(
      {
        name: 'Public bus',
        isDiscoverable: true,
        discoverability: 'public',
        surface: 'services',
        status: 'active',
        capabilities: { [CAP]: { instruction: 'x', responsePolicy: 'auto' } },
      },
      'pub-1',
    );
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('requester is not a contact → no grant, no offer', async () => {
    // no establishContact call
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('talk listing that is NOT known_only (talk+public) → no grant (policy-bypass close)', async () => {
    // A close + default-offerable contact would normally auto_grant; but a
    // talk+public listing authorizes via the UNGATED public ingress path, so
    // minting a grant for it would let a soft_reject'd contact reach it with a
    // bare service.query. The handler must refuse to resolve it.
    contact('spouse');
    setServiceConfig(
      {
        name: 'Leaky availability',
        isDiscoverable: true,
        discoverability: 'public', // talk + public — must NOT be grant-minted
        surface: 'talk',
        defaultOfferable: true,
        status: 'active',
        capabilities: { [CAP]: { instruction: 'x', responsePolicy: 'review' } },
      },
      'leaky-1',
    );
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('handleServiceGrantRequest — people-graph relationship bridge', () => {
  // A user asserts relationships in CHAT ("remember Alonso is my brother"): the
  // brain extracts it into the PEOPLE GRAPH as the person's `relationshipHint`,
  // NOT into the contact directory's `relationship` field that `closeness`
  // reads. The handler bridges the two stores — when the directory relationship
  // is unset, it consults the owner-asserted people-graph hint. These tests pin
  // the REAL two-store path (establishContact → applyExtraction, the same call
  // the remember drain makes), never a hand-built closeness input.
  function rememberRelationship(name: string, hint: Relationship): void {
    const repo = getPeopleRepository();
    if (repo === null) throw new Error('people repo not wired');
    // Mirrors the remember drain: applyExtraction with a high-confidence name
    // surface, which merges onto the DID-bound person establishContact created.
    repo.applyExtraction({
      sourceItemId: `mem-${name}-${hint}`,
      extractorVersion: 'test/remember-v1',
      results: [
        {
          canonicalName: name,
          relationshipHint: hint,
          sourceExcerpt: `${name} is my ${hint}`,
          surfaces: [{ surface: name, surfaceType: 'name', confidence: 'high' }],
        },
      ],
    });
  }

  it('directory relationship unset + people-graph hint "sibling" → auto_grant', async () => {
    // Contact added with NO relationship (defaults to 'unknown')...
    contact('unknown');
    // ...but the owner said "remember Alonso is my brother" in chat.
    rememberRelationship('Alonso', 'sibling');
    talkListing(true);

    // Precondition: the hint is bound to the requester DID (the extraction
    // merged onto the contact's person, not a stray new record). This is the
    // exact lookup the bridge performs.
    const repo = getPeopleRepository();
    expect(repo?.resolveByIdentity('did', REQUESTER)?.relationshipHint).toBe('sibling');

    await handleServiceGrantRequest(REQUESTER, request);

    // The bridge lifts closeness 'unknown' → 'close' → auto_grant mints + offers.
    expect(created).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('service.offer');
    expect(pendingEvents).toHaveLength(0);
  });

  it('explicit directory relationship WINS over a conflicting people-graph hint', async () => {
    // The owner deliberately tagged the contact as an acquaintance in the
    // directory; a looser/stale people-graph hint must NOT override that to
    // auto-grant. Directory-set relationship is authoritative; the hint only
    // fills the gap when the directory says 'unknown'.
    contact('acquaintance');
    rememberRelationship('Alonso', 'sibling');
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('free-form hint ("doctor") is not a close relationship → soft_reject', async () => {
    // relationshipHint is free-form; only the closed Relationship vocabulary
    // counts. A hint outside it falls through to 'unknown' (soft_reject), never
    // a spurious grant.
    contact('unknown');
    rememberRelationship('Alonso', 'doctor' as Relationship);
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('handleServiceGrantRequest — owner-private decision log', () => {
  // The requester-visible outcome is collapsed (§2); the GRANTOR records the
  // truth here (§10). Every branch must log exactly one decision so the owner
  // can review mis-tiered contacts. The requester never sees this.
  function decisions(): ReturnType<NonNullable<ReturnType<typeof getServiceDecisionRepository>>['list']> {
    const repo = getServiceDecisionRepository();
    if (repo === null) throw new Error('decision repo not wired');
    return repo.list();
  }

  it('auto_grant → records "granted"', async () => {
    contact('spouse');
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    const log = decisions();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      requesterDid: REQUESTER,
      capability: CAP,
      decision: 'granted',
    });
  });

  it('soft_reject (distant) → records "auto_declined" with the closeness tier', async () => {
    contact('acquaintance');
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    const log = decisions();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ decision: 'auto_declined', reason: 'closeness=distant' });
  });

  it('ask_to_enable (friend) → writes NO decision row (Core only decides to ask)', async () => {
    // Core DECIDES ask_to_enable + emits the pending event, but the prompt may
    // never actually post (mobile fans it out best-effort). The owner-private
    // `prompt_shown` row is written by the mobile surface when the card is
    // durably posted — never optimistically here — so the log can't claim a
    // prompt that was never shown.
    contact('friend');
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(decisions()).toHaveLength(0);
  });

  it('no talk listing → records "auto_declined" reason=no_talk_listing', async () => {
    contact('spouse');
    // no listing registered
    await handleServiceGrantRequest(REQUESTER, request);
    expect(decisions()[0]).toMatchObject({ decision: 'auto_declined', reason: 'no_talk_listing' });
  });

  it('does NOT log for a non-contact (defensive path stays infra-audit only)', async () => {
    // no establishContact — requester is unknown
    talkListing(true);
    await handleServiceGrantRequest(REQUESTER, request);
    expect(decisions()).toHaveLength(0);
  });
});
