/**
 * SHELF_SPACE_NEGOTIATION — the owner's term routes and the workflow rules
 * for term cards: owner-only, presence where the act moves floors, publishes
 * or ends a deal, presence on the two cards that bind a deal, Brain
 * refused and redacted, and the public record written before the local one.
 */

import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import {
  installTermListingRepo,
  reconcileTermListings,
} from '../../../src/commerce/term/term_listing_repo';
import {
  TERM_DECISION_CARD,
  TERM_FLOOR_CARD,
  TERM_STRANGER_CARD,
} from '../../../src/commerce/term/term_seller';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { createCoreRouter } from '../../../src/server/core_server';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import { Fleet, juicePolicy, STORE_DID, type Node } from '../../commerce/term/term_harness';

import type { CoreRequest, CoreResponse } from '../../../src/server/router';
import type { TermListing } from '@dina/commerce-protocol';

const OWNER_CAP = 'owner-capability-for-term-routes-0123';
const router = createCoreRouter({ ownerCapability: OWNER_CAP });

function owner(
  path: string,
  body: Record<string, unknown> = {},
  method: CoreRequest['method'] = 'POST',
  params: Record<string, string> = {},
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params,
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: OWNER_CAP,
  };
}

function isPresenceRefusal(res: CoreResponse): boolean {
  return res.status === 403 && (res.body as { error?: string }).error === 'no_user_presence';
}

let fleet: Fleet;
let store: Node;
let written: TermListing[];
let removed: string[];

beforeEach(() => {
  fleet = new Fleet();
  store = fleet.add(STORE_DID);
  setNodeDID(STORE_DID);
  installCommerceRuntime({ terms: store.engine } as unknown as CommerceRuntime);
  written = [];
  removed = [];
  installTermListingRepo({
    put: async (listing) => {
      written.push(listing);
      return { cid: 'bafy-listing' };
    },
    remove: async (id) => {
      removed.push(id);
    },
  });
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
});

afterEach(() => {
  installCommerceRuntime(null);
  installTermListingRepo(null);
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
  fleet.closeAll();
});

async function present(): Promise<void> {
  await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
}

describe('the owner’s term routes', () => {
  it('are owner-only: a call without the owner capability is refused', async () => {
    const res = await router.handle({
      ...owner('/v1/commerce/terms/policy', {}, 'GET'),
      ownerCapability: 'wrong',
    } as CoreRequest);
    expect(res.status).toBe(403);
  });

  it('setting the policy needs presence, and a bad policy is refused with its reason', async () => {
    const refused = await router.handle(
      owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'),
    );
    expect(isPresenceRefusal(refused)).toBe(true);
    await present();
    const bad = await router.handle(
      owner('/v1/commerce/terms/policy', { policy: { enabled: true } }, 'PUT'),
    );
    expect(bad.status).toBe(400);
    const ok = await router.handle(
      owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'),
    );
    expect(ok).toEqual({ status: 200, body: { ok: true, revision: 1, withdrawn: [] } });
    const read = await router.handle(owner('/v1/commerce/terms/policy', {}, 'GET'));
    expect((read.body as { policy: { enabled: boolean } }).policy.enabled).toBe(true);
  });

  it('publishing writes the public record first; a failed write leaves nothing published here', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    const listingBody = {
      resource_ref: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['snacks'],
    };
    installTermListingRepo({
      put: async () => {
        throw new Error('repo down');
      },
      remove: async () => undefined,
    });
    const failed = await router.handle(owner('/v1/commerce/terms/listings', listingBody));
    expect(failed.status).toBe(502);
    // Nothing published here; the write may have landed all the same, so the
    // listing is kept as withdrawn and possibly public, for the sweeper to clear.
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', true],
    ]);
    const cleared: string[] = [];
    installTermListingRepo({
      put: async () => ({ cid: 'x' }),
      remove: async (id) => void cleared.push(id),
    });
    await reconcileTermListings(store.engine);
    expect(cleared).toEqual(['slot-3']);
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', false],
    ]);
    installTermListingRepo({
      put: async (listing) => {
        written.push(listing);
        return { cid: 'bafy' };
      },
      remove: async (id) => {
        removed.push(id);
      },
    });
    const ok = await router.handle(owner('/v1/commerce/terms/listings', listingBody));
    expect(ok.status).toBe(200);
    expect(written).toHaveLength(1);
    // No money anywhere in the public record.
    expect(JSON.stringify(written[0])).not.toMatch(/250000|150000|minor_units|fee|share/);
    expect(
      store.engine.listings().map((l) => [l.state, l.recordPublic, l.listing.listing_digest]),
    ).toEqual([['published', true, written[0]?.listing_digest]]);
    const withdrawn = await router.handle(
      owner('/v1/commerce/terms/listings/slot-3', {}, 'DELETE', { id: 'slot-3' }),
    );
    expect(withdrawn).toEqual({ status: 200, body: { ok: true, record_removed: true } });
    expect(removed).toEqual(['slot-3']);
    // A republish of that withdrawn listing fails too: tracked again for removal.
    installTermListingRepo({
      put: async () => {
        throw new Error('repo down');
      },
      remove: async (id) => void removed.push(id),
    });
    expect((await router.handle(owner('/v1/commerce/terms/listings', listingBody))).status).toBe(
      502,
    );
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', true],
    ]);
    await reconcileTermListings(store.engine);
    expect(removed).toEqual(['slot-3', 'slot-3']);
  });

  it('a failed republish of a live listing leaves it live: its row and record are untouched', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    const listingBody = {
      resource_ref: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['snacks'],
    };
    const removed: string[] = [];
    installTermListingRepo({
      put: async () => ({ cid: 'bafy' }),
      remove: async (id) => void removed.push(id),
    });
    expect((await router.handle(owner('/v1/commerce/terms/listings', listingBody))).status).toBe(
      200,
    );
    const live = store.engine
      .listings()
      .map((l) => [l.state, l.recordPublic, l.listing.listing_digest]);
    installTermListingRepo({
      put: async () => {
        throw new Error('repo down');
      },
      remove: async (id) => void removed.push(id),
    });
    expect((await router.handle(owner('/v1/commerce/terms/listings', listingBody))).status).toBe(
      502,
    );
    await reconcileTermListings(store.engine);
    expect(
      store.engine.listings().map((l) => [l.state, l.recordPublic, l.listing.listing_digest]),
    ).toEqual(live);
    expect(removed).toEqual([]);
  });

  it('the listing is noted before its record is written, so a node stopping mid-write leaves it findable', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    let seenDuringPut: unknown = null;
    installTermListingRepo({
      put: async () => {
        // The moment the record goes out — a crash here must leave a trace.
        seenDuringPut = store.engine.listings().map((l) => [l.state, l.recordPublic]);
        return { cid: 'bafy' };
      },
      remove: async () => undefined,
    });
    const ok = await router.handle(
      owner('/v1/commerce/terms/listings', {
        resource_ref: 'slot-3',
        kind: 'shelf',
        region: { scheme: 'postal_area', value: 'IN-560034' },
        tags: ['snacks'],
      }),
    );
    expect(ok.status).toBe(200);
    expect(seenDuringPut).toEqual([['withdrawn', true]]);
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['published', true],
    ]);
  });

  it('turning renting off withdraws its listings; one the directory would not remove stays marked public until a retry lands', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    const listingBody = (ref: string) => ({
      resource_ref: ref,
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['snacks'],
    });
    for (const ref of ['slot-3', 'slot-4']) {
      expect(
        (await router.handle(owner('/v1/commerce/terms/listings', listingBody(ref)))).status,
      ).toBe(200);
    }
    let failNext = true;
    installTermListingRepo({
      put: async () => ({ cid: 'bafy' }),
      remove: async (id) => {
        if (id === 'slot-4' && failNext) {
          failNext = false;
          throw new Error('directory down');
        }
        removed.push(id);
      },
    });
    const off = await router.handle(
      owner('/v1/commerce/terms/policy', { policy: juicePolicy({ enabled: false }) }, 'PUT'),
    );
    expect(off.status).toBe(200);
    expect((off.body as { withdrawn: unknown }).withdrawn).toEqual([
      { listing_id: 'slot-3', record_removed: true },
      { listing_id: 'slot-4', record_removed: false },
    ]);
    // Withdrawn here at once, both; only slot-4 may still stand in the directory.
    expect(
      store.engine.listings().map((l) => [l.listing.listing_id, l.state, l.recordPublic]),
    ).toEqual([
      ['slot-3', 'withdrawn', false],
      ['slot-4', 'withdrawn', true],
    ]);
    // With renting off, nothing new can be listed …
    const refused = await router.handle(
      owner('/v1/commerce/terms/listings', listingBody('slot-3')),
    );
    expect(refused.status).toBe(400);
    // … and the retry lands the removal.
    const retried = await router.handle(
      owner('/v1/commerce/terms/listings/slot-4', {}, 'DELETE', { id: 'slot-4' }),
    );
    expect(retried.body).toEqual({ ok: true, record_removed: true });
    expect(
      store.engine.listings().find((l) => l.listing.listing_id === 'slot-4')?.recordPublic,
    ).toBe(false);
  });

  it('a withdrawal sent while a republish is still writing its record wins: the listing ends withdrawn and gone', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    const listingBody = {
      resource_ref: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['snacks'],
    };
    expect((await router.handle(owner('/v1/commerce/terms/listings', listingBody))).status).toBe(
      200,
    );
    // The directory is slow: the republish's record write waits until released.
    const records = new Set<string>(['slot-3']);
    let releasePut: () => void = () => undefined;
    const putStarted = new Promise<void>((started) => {
      installTermListingRepo({
        put: async (listing) => {
          started();
          await new Promise<void>((land) => (releasePut = land));
          records.add(listing.listing_id);
          return { cid: 'bafy-2' };
        },
        remove: async (id) => {
          records.delete(id);
        },
      });
    });
    const republish = router.handle(owner('/v1/commerce/terms/listings', listingBody));
    await putStarted;
    const withdrawal = router.handle(
      owner('/v1/commerce/terms/listings/slot-3', {}, 'DELETE', { id: 'slot-3' }),
    );
    releasePut();
    const [published, withdrawn] = await Promise.all([republish, withdrawal]);
    expect(published.status).toBe(200);
    expect(withdrawn.body).toEqual({ ok: true, record_removed: true });
    // The withdrawal ran after the republish, whole: nothing undid it.
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', false],
    ]);
    expect(records.has('slot-3')).toBe(false);
  });

  it('a policy save sent while a publish is writing waits for it, then takes that listing down too — and says so', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    const records = new Set<string>();
    let releasePut: () => void = () => undefined;
    let gated = true;
    const putStarted = new Promise<void>((started) => {
      installTermListingRepo({
        put: async (listing) => {
          if (gated) {
            gated = false;
            started();
            await new Promise<void>((land) => (releasePut = land));
          }
          records.add(listing.listing_id);
          return { cid: 'bafy' };
        },
        remove: async (id) => {
          records.delete(id);
        },
      });
    });
    const publish = router.handle(
      owner('/v1/commerce/terms/listings', {
        resource_ref: 'slot-3',
        kind: 'shelf',
        region: { scheme: 'postal_area', value: 'IN-560034' },
        tags: ['snacks'],
      }),
    );
    await putStarted;
    // Renting is switched off while the publish's record is still being written.
    const saved = router.handle(
      owner('/v1/commerce/terms/policy', { policy: juicePolicy({ enabled: false }) }, 'PUT'),
    );
    releasePut();
    const [published, off] = await Promise.all([publish, saved]);
    expect(published.status).toBe(200);
    // The save came after the publish, whole: it found the listing and took it down.
    expect((off.body as { withdrawn: unknown }).withdrawn).toEqual([
      { listing_id: 'slot-3', record_removed: true },
    ]);
    expect(store.engine.listings().map((l) => [l.state, l.recordPublic])).toEqual([
      ['withdrawn', false],
    ]);
    expect(records.size).toBe(0);
  });

  it('who may ask is set per listing on publish, kept on a republish, and never on the policy', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    installTermListingRepo({ put: async () => ({ cid: 'bafy' }), remove: async () => undefined });
    const listingBody = {
      resource_ref: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['snacks'],
    };
    const accessOf = () => store.engine.listings().map((l) => l.access);
    // No setting sent: the default, contacts_or_card.
    expect((await router.handle(owner('/v1/commerce/terms/listings', listingBody))).status).toBe(200);
    expect(accessOf()).toEqual(['contacts_or_card']);
    const opened = await router.handle(
      owner('/v1/commerce/terms/listings', { ...listingBody, access: 'anyone' }),
    );
    expect(opened.status).toBe(200);
    expect(accessOf()).toEqual(['anyone']);
    // The setting is the owner's own: the public record does not carry it.
    expect(JSON.stringify((opened.body as { listing: unknown }).listing)).not.toMatch(/anyone|access/);
    // A republish that sends none keeps it.
    expect((await router.handle(owner('/v1/commerce/terms/listings', listingBody))).status).toBe(200);
    expect(accessOf()).toEqual(['anyone']);
    const bad = await router.handle(
      owner('/v1/commerce/terms/listings', { ...listingBody, access: 'friends' }),
    );
    expect(bad.status).toBe(400);
    // A policy still carrying the old store-wide setting is refused, so a stale client learns.
    const stale = await router.handle(
      owner('/v1/commerce/terms/policy', { policy: { ...juicePolicy(), access: 'anyone' } }, 'PUT'),
    );
    expect(stale.status).toBe(400);
  });

  it('a listing with a category outside the pack, or for a resource without terms, is refused', async () => {
    await present();
    await router.handle(owner('/v1/commerce/terms/policy', { policy: juicePolicy() }, 'PUT'));
    const badTag = await router.handle(
      owner('/v1/commerce/terms/listings', {
        resource_ref: 'slot-3',
        kind: 'shelf',
        region: { scheme: 'country', value: 'IN' },
        tags: ['weapons'],
      }),
    );
    expect(badTag.status).toBe(400);
    const noTerms = await router.handle(
      owner('/v1/commerce/terms/listings', {
        resource_ref: 'slot-9',
        kind: 'shelf',
        region: { scheme: 'country', value: 'IN' },
        tags: ['snacks'],
      }),
    );
    expect(noTerms.status).toBe(400);
    expect(written).toEqual([]);
  });

  it('ending an agreement needs presence', async () => {
    const res = await router.handle(
      owner('/v1/commerce/terms/agreements/abc/terminate', {}, 'POST', { digest: 'abc' }),
    );
    expect(isPresenceRefusal(res)).toBe(true);
  });

  it('there is no route that proposes or decides a term agreement directly', async () => {
    for (const path of [
      '/v1/commerce/terms/agreements',
      '/v1/commerce/terms/proposals',
      '/v1/commerce/terms/decide',
    ]) {
      const res = await router.handle(owner(path, { proposal_digest: 'a'.repeat(64) }));
      expect([404, 405]).toContain(res.status);
    }
    // The revenue-share routes cannot reach a term proposal: it is not in their store.
    const decide = await router.handle(
      owner('/v1/commerce/trade/revshare/decide', {
        proposal_digest: 'a'.repeat(64),
        kind: 'accepted',
      }),
    );
    expect(decide.status).not.toBe(200);
  });
});

describe('term cards in the workflow inbox', () => {
  let workflow: WorkflowService;

  function raise(id: string, payload: Record<string, unknown>): void {
    workflow.create({
      id,
      kind: 'approval',
      description: id,
      payload: JSON.stringify(payload),
      initialState: 'pending_approval' as never,
    });
  }

  beforeEach(() => {
    workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
  });
  afterEach(() => setWorkflowService(null));

  it.each([TERM_PROPOSAL_CARD, TERM_DECISION_CARD, TERM_FLOOR_CARD])(
    'approving a %s card needs presence',
    async (type) => {
      raise('c1', { type, card_id: 'c1' });
      const refused = await router.handle({
        ...owner('/v1/workflow/tasks/c1/approve'),
        params: { id: 'c1' },
      });
      expect(isPresenceRefusal(refused)).toBe(true);
      await present();
      const approved = await router.handle({
        ...owner('/v1/workflow/tasks/c1/approve'),
        params: { id: 'c1' },
      });
      expect(isPresenceRefusal(approved)).toBe(false);
      expect(approved.status).toBe(200);
    },
  );

  it.each([TERM_PROPOSAL_CARD, TERM_DECISION_CARD])(
    'a %s card falls open on a node that cannot establish presence at all (owner decision, 2026-10-14)',
    async (type) => {
      installOwnerPresenceVerifier(null);
      raise('c2', { type, card_id: 'c2' });
      const approved = await router.handle({
        ...owner('/v1/workflow/tasks/c2/approve'),
        params: { id: 'c2' },
      });
      expect(isPresenceRefusal(approved)).toBe(false);
      expect(approved.status).toBe(200);
      // And the node says so, for the card's warning.
      const asked = await router.handle(owner('/v1/commerce/catalog/drafts/presence', {}, 'GET'));
      expect(asked).toEqual({ status: 200, body: { available: false } });
    },
  );

  it('the floor card falls open on such a node, like every other gated card', async () => {
    installOwnerPresenceVerifier(null);
    raise('c3', { type: TERM_FLOOR_CARD, card_id: 'c3' });
    const res = await router.handle({
      ...owner('/v1/workflow/tasks/c3/approve'),
      params: { id: 'c3' },
    });
    expect(isPresenceRefusal(res)).toBe(false);
  });

  it('the stranger card asks no presence (it binds nothing)', async () => {
    raise('c4', { type: TERM_STRANGER_CARD, card_id: 'c4' });
    const res = await router.handle({
      ...owner('/v1/workflow/tasks/c4/approve'),
      params: { id: 'c4' },
    });
    expect(isPresenceRefusal(res)).toBe(false);
  });

  it('Brain reads which card and which negotiation, never a number, and may not decide one', async () => {
    raise('c5', {
      type: TERM_DECISION_CARD,
      card_id: 'c5',
      request_id: 'treq-1',
      terms: [
        { name: 'fee', value: '195000' },
        { name: 'share_bps', value: '800' },
      ],
      holding: { tag: 'beverages.juice', already_held: 2, premium_bps_per_count: 1500 },
    });
    const brainRead = await router.handle({
      method: 'GET',
      path: '/v1/workflow/tasks/c5',
      query: {},
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: { id: 'c5' },
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    const text = JSON.stringify(brainRead.body);
    expect(text).not.toMatch(/195000|800|1500|already_held/);
    expect(text).toContain('treq-1');
    expect(text).toContain('owner_only');
    const brainDecide = await router.handle({
      ...owner('/v1/workflow/tasks/c5/approve'),
      callerType: 'brain',
      callerDID: 'did:key:brain',
      params: { id: 'c5' },
    } as CoreRequest);
    expect(brainDecide.status).toBe(403);
  });
});
