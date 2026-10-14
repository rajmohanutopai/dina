/**
 * SHELF_SPACE_NEGOTIATION W-02 — a store and a brand on the live TEST fleet.
 *
 *   npx tsx scripts/scenarios/shelf_live.ts            the run, AppView step skipped
 *   npx tsx scripts/scenarios/shelf_live.ts --appview  also find the listing through the test AppView
 *
 * Two local Core nodes, each with its own did:plc on the test PDS and in
 * SECURITY mode (a wrapped seed), so the two agreement cards ask for
 * presence and the run proves each yes was made with the passphrase. They meet only
 * through the test MsgBox. Every owner call is signed by a paired owner device
 * and carries the owner capability, as the phone's and the web app's are.
 *
 * Steps: turn the Slot Pack on (each side), set the store's private terms,
 * publish a listing (a real record on the test PDS: checked to hold no money),
 * the brand asks for it (the store's owner admits the stranger), Dina bargains,
 * both owners approve, the brand settles a period and the store accepts it,
 * both statements agree; then the listing is withdrawn. State lives under
 * scripts/scenarios/.fleet/shelf-* (git-ignored). Nothing secret is printed.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { pairOwnerSigner, type OwnerSigner } from '../../apps/home-node-lite/web/__e2e__/fixtures/owner_signer';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE = path.join(REPO_ROOT, 'scripts', 'scenarios', '.fleet');
const PDS = 'https://test-pds.dinakernel.com';
const APPVIEW = 'https://test-appview.dinakernel.com';
const COLLECTION = 'com.dinakernel.commerce.termListing';
const PASSPHRASE = `shelf-live-${randomBytes(8).toString('hex')}`;
const withAppView = process.argv.includes('--appview');

interface Node {
  name: string;
  core: string;
  cap: string;
  dir: string;
  pid: number;
  did: string;
  signer: OwnerSigner;
}

let failures = 0;
function step(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await probe();
    if (got !== null) return got;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function start(name: string, port: number, runTag: string): Omit<Node, 'did' | 'signer'> {
  const dir = path.join(STATE, `shelf-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const cap = randomBytes(24).toString('hex');
  const log = fs.openSync(path.join(dir, 'core.log'), 'a');
  const child = spawn('npx', ['tsx', 'src/bin.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/home-node-lite/core-server'),
    env: {
      ...process.env,
      DINA_CORE_HOST: '127.0.0.1',
      DINA_CORE_PORT: String(port),
      DINA_VAULT_DIR: vault,
      DINA_LOG_LEVEL: 'info',
      DINA_RATE_LIMIT: '100000',
      DINA_ENDPOINT_MODE: 'test',
      DINA_MSGBOX_ENABLED: 'true',
      DINA_PDS_PROVISION: '1',
      DINA_PDS_HANDLE: `sh${runTag}${name}.test-pds.dinakernel.com`,
      DINA_OWNER_CAPABILITY: cap,
      // Security mode from the first boot: the seed is wrapped under this
      // passphrase, and presence is proven with it.
      DINA_UNLOCK_PASSPHRASE: PASSPHRASE,
    },
    stdio: ['ignore', log, log],
    detached: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`${name}: could not start`);
  return { name, core: `http://127.0.0.1:${port}`, cap, dir, pid: child.pid };
}

async function call(n: Node, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = `${n.core}${route}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-dina-owner-capability': n.cap,
      ...n.signer.headers(method, url, text),
    },
    ...(body === undefined ? {} : { body: text }),
  });
  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = raw === '' ? {} : JSON.parse(raw);
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed };
}

async function present(n: Node): Promise<void> {
  const r = await call(n, 'POST', '/v1/commerce/catalog/drafts/presence', { passphrase: PASSPHRASE });
  if (r.status !== 200) throw new Error(`${n.name}: presence ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}

async function turnOn(n: Node, side: 'seller' | 'buyer'): Promise<boolean> {
  await present(n);
  const begun = await call(n, 'POST', '/v1/commerce/terms/install/begin', { side });
  if (begun.status !== 200) return false;
  const installId = String(begun.body.install_id);
  const bound = await call(n, 'POST', '/v1/commerce/install/bind_reference_runner', { install_id: installId });
  if (bound.status !== 200) return false;
  const confirmed = await call(n, 'POST', '/v1/commerce/install/confirm', {
    install_id: installId,
    device_did: bound.body.device_did,
  });
  return confirmed.status === 200 && confirmed.body.status === 'active';
}

async function pendingCard(n: Node, type: string): Promise<{ id: string; payload: any } | null> {
  const r = await call(n, 'GET', '/v1/workflow/tasks?kind=approval&state=pending_approval&limit=50');
  const tasks = (r.body?.tasks ?? []) as { id: string; payload: string }[];
  for (const t of tasks) {
    const payload = JSON.parse(t.payload) as { type?: string };
    if (payload.type === type) return { id: t.id, payload };
  }
  return null;
}

async function approve(n: Node, cardId: string): Promise<number> {
  await present(n);
  return (await call(n, 'POST', `/v1/workflow/tasks/${encodeURIComponent(cardId)}/approve`, {})).status;
}

function stop(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* gone */
  }
}

async function main(): Promise<void> {
  const runTag = randomBytes(3).toString('hex');
  const started = [start('store', 18521, runTag), start('brand', 18522, runTag)];
  const nodes: Node[] = [];
  try {
    for (const s of started) {
      await until(`${s.name} core`, 120_000, async () => {
        try {
          return (await fetch(`${s.core}/healthz`)).ok ? true : null;
        } catch {
          return null;
        }
      });
      const did = await until(`${s.name} did:plc`, 90_000, async () => {
        const file = path.join(s.dir, 'vault', 'pds_identity.json');
        if (!fs.existsSync(file)) return null;
        const value = (JSON.parse(fs.readFileSync(file, 'utf8')) as { did?: unknown }).did;
        return typeof value === 'string' ? value : null;
      });
      nodes.push({ ...s, did, signer: await pairOwnerSigner(s.core, s.cap, PASSPHRASE) });
    }
    const [store, brand] = nodes as [Node, Node];
    console.log(`store ${store.did}\nbrand ${brand.did}`);

    // 1. Each side turns its half of the Slot Pack on.
    step('store turns the Slot Pack (store) on', await turnOn(store, 'seller'));
    step('brand turns the Slot Pack (brand) on', await turnOn(brand, 'buyer'));

    // 2. The store's private terms: ₹2500 asking, ₹1500 floor, ₹1800 automatic; strangers need a yes.
    await present(store);
    const policy = await call(store, 'PUT', '/v1/commerce/terms/policy', {
      policy: {
        enabled: true,
        access: 'contacts_or_card',
        maxRounds: 3,
        windowSeconds: 7 * 24 * 60 * 60,
        maxCountersPerBuyerPerDay: 20,
        resources: [
          {
            resource_ref: 'slot-3',
            currency: 'INR',
            asking: { fee: '250000', share_bps: '1000' },
            floors: { fee: { hard: '150000', auto: '180000' }, share_bps: { hard: '500' } },
            available: { from: '2027-01-01T00:00:00Z', to: '2028-12-31T00:00:00Z' },
            conditions: { period: 'monthly', cash_handler: 'vendor', exit_notice_days: 30 },
          },
        ],
        holding_rules: [{ tag: 'beverages.juice', premium_bps_per_count: 1500, max_count: 4 }],
        manual_holdings: [],
      },
    });
    step('store saves its terms (presence-gated)', policy.status === 200, `HTTP ${policy.status}`);

    // 3. Publish: a real record on the test PDS, with no money in it.
    await present(store);
    const published = await call(store, 'POST', '/v1/commerce/terms/listings', {
      resource_ref: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['beverages.juice', 'snacks'],
    });
    step('store publishes the listing', published.status === 200, `HTTP ${published.status}`);
    const uri = String(published.body.uri);
    const onPds = await fetch(
      `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${store.did}&collection=${COLLECTION}&rkey=slot-3`,
    ).then((r) => r.json() as Promise<{ value?: Record<string, unknown> }>);
    const record = onPds.value ?? {};
    step('the listing is on the test PDS', record.listing_id === 'slot-3');
    // Field names and values, the digest and DIDs aside: a 64-character hex
    // digest can spell "fee" by chance, which says nothing about the record.
    const leaks: string[] = [];
    const scan = (value: unknown, key: string): void => {
      if (/fee|share|floor|asking|price|rent|minor/i.test(key)) leaks.push(`field ${key}`);
      if (typeof value === 'string' && key !== 'listing_digest' && !value.startsWith('did:')) {
        if (/250000|150000|180000|fee|share|floor|asking/i.test(value)) leaks.push(`${key}=${value}`);
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) scan(v, k);
      }
    };
    scan(record, '');
    step('the public record carries none of the store’s numbers', leaks.length === 0, leaks.join(', '));
    const { $type: _type, ...listing } = record;

    // 4. Optionally, the brand finds it through the test AppView.
    let found: Record<string, unknown> = listing;
    if (withAppView) {
      const hit = await until('the listing in the test AppView', 180_000, async () => {
        const r = await fetch(`${APPVIEW}/xrpc/com.dinakernel.commerce.getTermListing?uri=${encodeURIComponent(uri)}`);
        if (!r.ok) return null;
        const body = (await r.json()) as { listing?: { listing?: Record<string, unknown> } | null };
        return body.listing?.listing ?? null;
      }).catch(() => null);
      step('the brand finds the listing through the test AppView', hit !== null);
      if (hit !== null) found = hit;
    } else {
      console.log('SKIP  finding the listing through the test AppView (run with --appview once it is deployed)');
    }

    // 5. The brand asks; the store's owner admits the stranger.
    const asked = await call(brand, 'POST', '/v1/commerce/terms/negotiations', {
      listing: found,
      listing_uri: uri,
      tag: 'beverages.juice',
      attributes: { skus: 4 },
      start: '2027-02-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
      policy: {
        currency: 'INR',
        targets: { fee: '170000', share_bps: '600' },
        ceilings: { fee: '300000', share_bps: '1000' },
        max_rounds: 2,
        deadline_seconds: 3 * 24 * 60 * 60,
      },
    });
    step('brand asks for the slot', asked.status === 200, `HTTP ${asked.status}`);
    const requestId = String(asked.body.request_id);
    const stranger = await until('the store’s stranger card', 180_000, () => pendingCard(store, 'term_stranger_request'));
    step('the store is asked about a brand it does not know', stranger !== null);
    step('the store admits the stranger', (await approve(store, stranger.id)) === 200);

    // 6. Dina bargains; the brand's card comes when an offer is ready.
    const proposalCard = await until('the brand’s proposal card', 300_000, () => pendingCard(brand, 'term_agreement_proposal'));
    const negotiations = await call(brand, 'GET', '/v1/commerce/terms/negotiations');
    const mine = (negotiations.body.negotiations as { requestId: string; head: { terms: { name: string; value: string }[] } | null }[]).find(
      (n) => n.requestId === requestId,
    );
    const fee = mine?.head?.terms.find((t) => t.name === 'fee')?.value;
    step('Dina bargained the rent down, never below the store’s automatic limit', fee !== undefined && BigInt(fee) < 250000n && BigInt(fee) >= 180000n, `rent ${fee ?? '?'}`);
    step('the brand’s card shows the terms its yes binds', JSON.stringify(proposalCard.payload).includes('exit_notice_days'));

    // 7. Both owners approve.
    step('brand approves the proposal (presence)', (await approve(brand, proposalCard.id)) === 200);
    const decisionCard = await until('the store’s decision card', 300_000, () => pendingCard(store, 'term_agreement_decision'));
    step('store approves the agreement (presence)', (await approve(store, decisionCard.id)) === 200);
    const agreed = await until('the agreement on both sides', 300_000, async () => {
      const a = await call(brand, 'GET', '/v1/commerce/terms/agreements');
      const s = await call(store, 'GET', '/v1/commerce/terms/agreements');
      const ours = (a.body.agreements ?? []).find((x: any) => x.state === 'accepted' && x.delivery === 'delivered');
      const theirs = (s.body.agreements ?? []).find((x: any) => x.state === 'accepted' && x.delivery === 'delivered');
      return ours !== undefined && theirs !== undefined && ours.proposalDigest === theirs.proposalDigest ? ours : null;
    });
    step('both sides hold the same accepted agreement, both answers delivered', true, String(agreed.proposalDigest).slice(0, 12));

    // 8. The brand (holding the takings) settles February; the store accepts it.
    const digest = String(agreed.proposalDigest);
    const detail = await call(brand, 'GET', `/v1/commerce/terms/agreements/${digest}`);
    const first = detail.body.schedule?.[0] as { start: string; end: string } | undefined;
    const settled = await call(brand, 'POST', `/v1/commerce/terms/agreements/${digest}/settlements`, {
      period_start: first?.start,
      period_end: first?.end,
      gross_minor: '2000000',
    });
    step('brand settles the first period', settled.status === 200, `HTTP ${settled.status}`);
    const toAnswer = await until('the settlement at the store', 300_000, async () => {
      const r = await call(store, 'GET', `/v1/commerce/terms/agreements/${digest}`);
      return (r.body.unanswered?.[0] as string | undefined) ?? null;
    });
    const acked = await call(store, 'POST', `/v1/commerce/terms/settlements/${toAnswer}/ack`, { kind: 'accepted' });
    step('store accepts the figures', acked.status === 200, `HTTP ${acked.status}`);
    const statements = await until('the same statement on both sides', 300_000, async () => {
      const a = (await call(brand, 'GET', `/v1/commerce/terms/agreements/${digest}`)).body.statement;
      const s = (await call(store, 'GET', `/v1/commerce/terms/agreements/${digest}`)).body.statement;
      return a?.ok === true && JSON.stringify(a) === JSON.stringify(s) ? a : null;
    });
    step('both statements agree', statements.direction === 'vendor_owes_host', `${statements.direction}, owed ${statements.owed_minor}`);

    // 9. Withdraw the listing: here and from the PDS.
    await present(store);
    const withdrawn = await call(store, 'DELETE', '/v1/commerce/terms/listings/slot-3');
    step('the store withdraws the listing, record removed', withdrawn.body?.record_removed === true);
    const gone = await fetch(`${PDS}/xrpc/com.atproto.repo.getRecord?repo=${store.did}&collection=${COLLECTION}&rkey=slot-3`);
    step('the PDS no longer serves it', gone.status === 400 || gone.status === 404, `HTTP ${gone.status}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const s of started) stop(s.pid);
  }
  console.log(failures === 0 ? '\nW-02: all steps passed' : `\nW-02: ${String(failures)} step(s) failed — logs in scripts/scenarios/.fleet/shelf-*/core.log`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
