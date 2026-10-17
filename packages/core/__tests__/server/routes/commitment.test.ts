/**
 * COMMITMENT_KERNEL §7 — the Core form for the value model (step 2 of §15).
 *
 *   C-01  owner only: the wrong capability and Brain are refused;
 *   C-02  the form needs the owner present; a shelf kind refuses every field
 *         its engine does not apply yet (shelf floors, asking terms and totals
 *         live on the shelf forms; shelf deals stay subject to a card);
 *   C-02b a kind that applies every field checks each against its vocabulary;
 *   C-03  entries: a value or never-rule is checked against the vocabulary; a
 *         persona's entry needs the persona open; never-rules list by label;
 *   C-07  a never-rule's tests must fit their parts: a figure on a number, an
 *         option of the choice's own, a flag on a flag; the seller's share of
 *         a saving is one entry under a fixed id;
 *   C-08  the owner can set what step 7 needs: a shipper's asking fee, and
 *         a goods seller's firm rule;
 *   C-09  the strategy setting shows both choices' words before one is made,
 *         says no values for a kind that takes none, and names the saving
 *         share the next quote uses and who set it, or that the selling rules
 *         are in a closed persona or cannot be read (§15 step 11).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { dealKind, type DealKind } from '../../../src/commerce/deal_kinds';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { installValueModelStore, ValueModelStore } from '../../../src/commitment/model_store';
import {
  installStandingChoiceStore,
  SAVING_SHARE_BPS,
  StandingChoiceStore,
} from '../../../src/commitment/standing_choices';
import { installStrategyStore, StrategyStore } from '../../../src/commitment/strategy_store';
import { createCoreRouter } from '../../../src/server/core_server';
import { parseForm } from '../../../src/server/routes/commitment';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import type { CoreRequest } from '../../../src/server/router';

const OWNER_CAP = 'owner-capability-for-commitment-0123';
const router = createCoreRouter({ ownerCapability: OWNER_CAP });

function owner(
  method: CoreRequest['method'],
  urlPath: string,
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
): CoreRequest {
  return {
    method,
    path: urlPath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params,
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: OWNER_CAP,
  } as CoreRequest;
}

const KIND = { kind: 'shelf_space.host' };

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('test: missing value');
  return value;
}
const FORM = {
  walk_away: '900',
  auto_sign: '1200',
  limits: { fee: { hard: '80000', auto: '100000' }, share_bps: { hard: '500', auto: '600' } },
  totals: { overall: '5000' },
  asking: { fee: '250000', share_bps: '1000' },
  binding: 'card',
};

describe('the value model’s Core form', () => {
  let dir: string;
  let identity: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-commitment-'));
    identity = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(identity, IDENTITY_MIGRATIONS);
    installValueModelStore(new ValueModelStore(identity, { db: () => null, isOpen: () => false }));
    installStrategyStore(new StrategyStore(identity));
    installStandingChoiceStore(new StandingChoiceStore(identity));
    installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  });
  afterEach(() => {
    installValueModelStore(null);
    installStrategyStore(null);
    installStandingChoiceStore(null);
    clearOwnerPresence();
    installOwnerPresenceVerifier(null);
    identity.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const present = () => proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);

  it('C-01: refuses the wrong capability and Brain', async () => {
    const wrong = await router.handle({
      ...owner('GET', '/v1/commitment/models/shelf_space.host', {}, KIND),
      ownerCapability: 'wrong',
    } as CoreRequest);
    expect(wrong.status).toBe(403);
    const brain = await router.handle({
      ...owner('GET', '/v1/commitment/models/shelf_space.host', {}, KIND),
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    expect(brain.status).toBe(403);
  });

  it('C-02: the form needs presence and refuses what a shelf kind does not apply', async () => {
    const put = (form: unknown) =>
      router.handle(owner('PUT', '/v1/commitment/models/shelf_space.host/form', { form }, KIND));
    expect((await put({ binding: 'card' })).status).toBe(403);
    await present();
    // Shelf floors, asking terms and totals live on the shelf forms, and shelf
    // deals stay subject to a card: the kind's form takes none of them.
    for (const [field, form] of [
      ['walk_away', { binding: 'card', walk_away: '900' }],
      ['auto_sign', { binding: 'card', auto_sign: '1200' }],
      ['limits', { binding: 'card', limits: { fee: { hard: '80000', auto: '100000' } } }],
      ['totals', { binding: 'card', totals: { overall: '5000' } }],
      ['asking', { binding: 'card', asking: { fee: '250000' } }],
      ['firm', { binding: 'firm' }],
    ] as const) {
      const res = await put(form);
      expect([field, res.status, (res.body as { detail?: string }).detail]).toEqual([
        field,
        400,
        expect.stringMatching(/not applied to shelf_space.host deals yet/),
      ]);
    }
    expect(await put({ binding: 'card' })).toEqual({ status: 200, body: { ok: true, version: 1 } });
    const got = await router.handle(
      owner('GET', '/v1/commitment/models/shelf_space.host', {}, KIND),
    );
    expect(got.body).toEqual({
      kind: 'shelf_space.host',
      version: 1,
      form: { limits: {}, totals: {}, asking: {}, binding: 'card' },
      never: [],
      closed_personas: [],
    });
    const unknown = await router.handle(
      owner('GET', '/v1/commitment/models/nope', {}, { kind: 'nope' }),
    );
    expect(unknown.status).toBe(404);
  });

  it('C-02b: a kind that applies every field checks each against its vocabulary', () => {
    const host = must(dealKind('shelf_space.host'));
    const all: DealKind = {
      ...host,
      id: 'test.all',
      honours: new Set(['walk_away', 'auto_sign', 'limits', 'totals', 'asking', 'firm']),
    };
    for (const [broken, detail] of [
      [{ ...FORM, auto_sign: '800' }, /at or above the walk_away/],
      [{ ...FORM, walk_away: undefined }, /needs a walk_away/],
      [{ ...FORM, limits: { fee: { hard: '100000', auto: '80000' } } }, /no worse for you/],
      [{ ...FORM, limits: { rent: { hard: '1', auto: '1' } } }, /not a part of this kind/],
      [{ ...FORM, limits: { share_bps: { hard: '20000', auto: '20000' } } }, /10000/],
      [{ ...FORM, binding: 'maybe' }, /binding/],
    ] as const) {
      const parsed = parseForm(all, broken);
      expect(parsed.ok ? null : parsed.error).toMatch(detail);
    }
    const ok = parseForm(all, FORM);
    expect(ok.ok && ok.value).toEqual({
      walkAway: 900n,
      autoSign: 1200n,
      limits: { fee: { hard: 80_000n, auto: 100_000n }, share_bps: { hard: 500n, auto: 600n } },
      totals: { overall: 5000n },
      asking: { fee: '250000', share_bps: '1000' },
      binding: 'card',
    });
    // The brand's side: its limits run the other way.
    const vendor: DealKind = { ...all, holder: 'buyer' };
    expect(
      parseForm(vendor, { binding: 'card', limits: { fee: { hard: '300000', auto: '250000' } } })
        .ok,
    ).toBe(true);
  });

  it('C-03: entries are checked, and a persona entry needs the persona open', async () => {
    const put = (entry: unknown) =>
      router.handle(
        owner('PUT', '/v1/commitment/models/shelf_space.host/entries', { entry }, KIND),
      );
    const never = {
      id: 'short-notice',
      body: { type: 'never', label: 'no deals under ₹800', all: [{ part: 'fee', below: '80000' }] },
    };
    expect(await put(never)).toEqual({ status: 200, body: { ok: true, version: 1 } });
    expect(
      (await put({ ...never, body: { ...never.body, all: [{ part: 'rent', below: '1' }] } }))
        .status,
    ).toBe(400);
    expect(
      (await put({ id: 'x', body: { type: 'choice', part: 'day', option: 'tue', rupees: '0' } }))
        .status,
    ).toBe(400);
    expect(await put({ ...never, id: 'h1', persona: 'health' })).toEqual({
      status: 409,
      body: { error: 'persona_closed' },
    });
    const got = await router.handle(
      owner('GET', '/v1/commitment/models/shelf_space.host', {}, KIND),
    );
    expect((got.body as { never: string[] }).never).toEqual(['no deals under ₹800']);
    const removed = await router.handle(
      owner(
        'DELETE',
        '/v1/commitment/models/shelf_space.host/entries/short-notice',
        {},
        { ...KIND, id: 'short-notice' },
      ),
    );
    expect(removed).toEqual({ status: 200, body: { ok: true, version: 2 } });
  });

  it('C-04: a promise value names every declared dimension', async () => {
    const put = (entry: unknown) =>
      router.handle(
        owner(
          'PUT',
          '/v1/commitment/models/shelf_space.vendor/entries',
          { entry },
          { kind: 'shelf_space.vendor' },
        ),
      );
    const value = {
      id: 'run-cost',
      body: {
        type: 'promise',
        part: 'stock_run',
        dimensions: { crates: '2', day: 'tue', every_days: '7' },
        rupees: '-150',
      },
    };
    expect(await put(value)).toEqual({ status: 200, body: { ok: true, version: 1 } });
    expect(
      (await put({ ...value, body: { ...value.body, dimensions: { crates: '2', day: 'tue' } } }))
        .status,
    ).toBe(400);
    expect(
      (
        await put({
          ...value,
          body: { ...value.body, dimensions: { crates: 'many', day: 'tue', every_days: '7' } },
        })
      ).status,
    ).toBe(400);
    expect((await put({ ...value, body: { ...value.body, part: 'van_run' } })).status).toBe(400);
  });

  it('C-05: the store’s kind takes no values yet; a day must be one the pack allows', async () => {
    const host = await router.handle(
      owner(
        'PUT',
        '/v1/commitment/models/shelf_space.host/entries',
        {
          entry: {
            id: 'v1',
            body: {
              type: 'promise',
              part: 'stock_run',
              dimensions: { crates: '2', day: 'tue', every_days: '7' },
              rupees: '100',
            },
          },
        },
        KIND,
      ),
    );
    expect(host.status).toBe(400);
    const tuesday = await router.handle(
      owner(
        'PUT',
        '/v1/commitment/models/shelf_space.vendor/entries',
        {
          entry: {
            id: 'v2',
            body: {
              type: 'promise',
              part: 'stock_run',
              dimensions: { crates: '2', day: 'tuesday', every_days: '7' },
              rupees: '-150',
            },
          },
        },
        { kind: 'shelf_space.vendor' },
      ),
    );
    expect([tuesday.status, (tuesday.body as { detail?: string }).detail]).toEqual([
      400,
      expect.stringMatching(/mon \| tue/),
    ]);
  });

  it('C-06b: the organiser of a group booking has a strategy setting, and no value model (§15 step 11)', async () => {
    await present();
    const put = await router.handle(
      owner('PUT', '/v1/commitment/strategy/group.organizer', { strategy: 'brain' }, { kind: 'group.organizer' }),
    );
    expect(put.status).toBe(200);
    const got = await router.handle(
      owner('GET', '/v1/commitment/strategy/group.organizer', undefined, { kind: 'group.organizer' }),
    );
    expect(got.body).toMatchObject({ kind: 'group.organizer', strategy: 'brain' });
    const model = await router.handle(
      owner('GET', '/v1/commitment/models/group.organizer', undefined, { kind: 'group.organizer' }),
    );
    expect(model.status).toBe(404);
  });

  it('C-06: choosing Brain needs presence and says what Brain and its provider will see', async () => {
    const put = (body: Record<string, unknown>) =>
      router.handle(
        owner('PUT', '/v1/commitment/strategy/shelf_space.vendor', body, {
          kind: 'shelf_space.vendor',
        }),
      );
    expect((await put({ strategy: 'brain' })).status).toBe(403);
    await present();
    const on = await put({ strategy: 'brain' });
    expect(on.status).toBe(200);
    expect((on.body as { disclosure: string }).disclosure).toMatch(
      /never see your walk-away point/,
    );
    // §15 step 10: with values on, the text admits what offers can give away.
    expect((on.body as { disclosure: string }).disclosure).toMatch(
      /let the other side guess what a part is worth to you/,
    );
    const off = await put({ strategy: 'brain', values_on: false });
    expect((off.body as { disclosure: string }).disclosure).toMatch(/not what parts are worth/);
    expect((off.body as { disclosure: string }).disclosure).not.toMatch(/guess/);
    expect((await put({ strategy: 'somebody' })).status).toBe(400);
  });

  it('C-07: each test fits its part', async () => {
    const put = (all: unknown[]) =>
      router.handle(
        owner(
          'PUT',
          '/v1/commitment/models/goods.buyer/entries',
          { entry: { id: 'n1', body: { type: 'never', label: 'a rule', all } } },
          { kind: 'goods.buyer' },
        ),
      );
    expect((await put([{ part: 'delivery_day', choice: 'tue' }])).status).toBe(200);
    expect((await put([{ part: 'delivery_day', choice: 'Tuesday' }])).status).toBe(400);
    expect((await put([{ part: 'total', flag: true }])).status).toBe(400);
    expect((await put([{ part: 'delivery_day', below: '5' }])).status).toBe(400);
    expect((await put([{ part: 'total', present: true }, { part: 'delivery_day', choice: 'sun' }])).status).toBe(200);
    const share = (id: string) =>
      router.handle(
        owner(
          'PUT',
          '/v1/commitment/models/goods.seller/entries',
          { entry: { id, body: { type: 'choice', part: 'saving_share', option: 'third', rupees: '1' } } },
          { kind: 'goods.seller' },
        ),
      );
    expect((await share('my_share')).status).toBe(400);
    expect((await share('saving_share')).status).toBe(200);
  });

  it('C-08: a shipper\'s asking fee and a seller\'s firm rule are the owner\'s to set', async () => {
    const put = (kind: string, form: unknown) =>
      router.handle(owner('PUT', `/v1/commitment/models/${kind}/form`, { form }, { kind }));
    await present();
    expect(
      (await put('delivery.shipper', { binding: 'card', asking: { fee: '30000' }, limits: { fee: { hard: '20000', auto: '25000' } } }))
        .status,
    ).toBe(200);
    expect((await put('goods.seller', { binding: 'firm' })).status).toBe(200);
    expect((await put('goods.buyer', { binding: 'firm' })).status).toBe(400);
  });
  it('C-09: the strategy setting shows both choices, values only where they apply, and the share in use', async () => {
    const get = async (kind: string) =>
      (await router.handle(owner('GET', `/v1/commitment/strategy/${kind}`, undefined, { kind }))).body as {
        values_apply: boolean;
        disclosure: string;
        disclosures: { with_values: string; without_values: string };
        saving_share?: unknown;
      };
    const vendor = await get('shelf_space.vendor');
    expect(vendor.values_apply).toBe(true);
    expect(vendor.disclosures.with_values).toMatch(/what parts are worth to you\. They never/);
    expect(vendor.disclosures.without_values).toMatch(/not what parts are worth/);
    expect(vendor.saving_share).toBeUndefined();
    // The store's kind takes no values: Brain sees none, so neither text claims it does.
    const host = await get('shelf_space.host');
    expect(host.values_apply).toBe(false);
    expect(host.disclosure).toMatch(/not what parts are worth/);
    expect(host.disclosures.with_values).toBe(host.disclosures.without_values);
    await present();
    const put = await router.handle(
      owner('PUT', '/v1/commitment/strategy/shelf_space.host', { strategy: 'brain' }, { kind: 'shelf_space.host' }),
    );
    expect((put.body as { disclosure: string }).disclosure).toMatch(/not what parts are worth/);

    // Selling goods: half until the owner chooses; then the owner's; Brain's only while Brain is chosen.
    expect((await get('goods.seller')).saving_share).toEqual({ set_by: 'default', option: 'half' });
    const share = await router.handle(
      owner(
        'PUT',
        '/v1/commitment/models/goods.seller/entries',
        { entry: { id: 'saving_share', body: { type: 'choice', part: 'saving_share', option: 'most', rupees: '1' } } },
        { kind: 'goods.seller' },
      ),
    );
    expect(share.status).toBe(200);
    expect((await get('goods.seller')).saving_share).toEqual({ set_by: 'owner', option: 'most' });
    new StandingChoiceStore(identity).set('goods.seller', SAVING_SHARE_BPS, '4000', 'brain', Date.now());
    expect((await get('goods.seller')).saving_share).toEqual({ set_by: 'owner', option: 'most' });
    await router.handle(
      owner('PUT', '/v1/commitment/strategy/goods.seller', { strategy: 'brain' }, { kind: 'goods.seller' }),
    );
    expect((await get('goods.seller')).saving_share).toEqual({ set_by: 'brain', share_bps: 4000 });
    // The owner dropping their share clears Brain's too, until Brain sets another.
    await router.handle(
      owner('DELETE', '/v1/commitment/models/goods.seller/entries/saving_share', undefined, {
        kind: 'goods.seller',
        id: 'saving_share',
      }),
    );
    expect((await get('goods.seller')).saving_share).toEqual({ set_by: 'default', option: 'half' });

    // A selling rule in a closed persona withholds quotes; the share is not claimed.
    identity.execute(
      `INSERT INTO commitment_value_index (persona, kind, entry_id, covers) VALUES ('health', 'goods.seller', 'n9', 'delivery_day')`,
    );
    expect((await get('goods.seller')).saving_share).toEqual({ set_by: 'closed', personas: ['health'] });
    identity.execute(`DELETE FROM commitment_value_index`);
    // Rules that cannot be read: said so, never a 500 and never a made-up share.
    identity.execute(
      `INSERT INTO commitment_value_entries (kind, entry_id, entry_json, created_at) VALUES ('goods.seller', 'bad', '{', 0)`,
    );
    const unreadable = await router.handle(
      owner('GET', '/v1/commitment/strategy/goods.seller', undefined, { kind: 'goods.seller' }),
    );
    expect(unreadable.status).toBe(200);
    expect((unreadable.body as { saving_share: unknown }).saving_share).toEqual({ set_by: 'unreadable' });
  });
});
