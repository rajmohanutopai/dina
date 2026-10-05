/**
 * The search projection (UCP plan §3.16): what Core lets leave as a merchant
 * search, the owner's `ucp_search_review` card, and what Brain cannot do with
 * it. Real SQLite release log and chat history; a real workflow service.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

import { A2AReleaseLog, installA2AReleaseLog, RELEASE_LOG_TTL_MS } from '../../../src/a2a';
import { SQLiteChatMessageRepository } from '../../../src/chat/repository';
import { readConversationTaint } from '../../../src/chat/taint';
import {
  checkSearch,
  raiseSearchReview,
  useSearchReview,
  UCP_SEARCH_REVIEW_TYPE,
  type SearchRequest,
} from '../../../src/commerce/ucp/search_projection';
import { UcpSearchStore } from '../../../src/commerce/ucp/search_store';
import { createPersona, resetPersonaState } from '../../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { clearVaults, queryVault, storeItem } from '../../../src/vault/crud';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../../src/workflow/service';

const NOW = 1_800_000_000_000;
const SESSION = 'chat:main';
const A = 'https://a-shop.example';
const B = 'https://b-shop.example';
const C = 'https://c-shop.example';

let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let clock: number;
let chat: SQLiteChatMessageRepository;
let workflow: WorkflowService;
let n = 0;

beforeEach(async () => {
  resetFactoryCounters();
  clearVaults();
  resetPersonaState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  dir = mkdtempSync(path.join(tmpdir(), 'ucp-projection-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  clock = NOW;
  log = new A2AReleaseLog(db, () => clock, { chatLivesIn: 'core' });
  installA2AReleaseLog(log);
  chat = new SQLiteChatMessageRepository(db);
  workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    nowMsFn: () => clock,
  });
  setWorkflowService(workflow);
  storeItem('health', makeVaultItem({ summary: 'Blood test', body: 'Cholesterol 190.' }));
  await chat.append({
    id: 'm1',
    threadId: 'main',
    type: 'user',
    content: 'hi',
    metadata: {},
    sources: [],
    timestamp: clock,
  });
  // The owner is in the conversation now (Brain's chat entry records each turn).
  log.recordUtterance(SESSION, 't0', 'hi');
});

afterEach(() => {
  setWorkflowService(null);
  installA2AReleaseLog(null);
  resetPersonaState();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({
  log,
  taint: (s: string) => readConversationTaint(db, log, s),
  nowMs: () => clock,
});
const raiseDeps = () => ({
  ...deps(),
  workflow,
  reviews: new UcpSearchStore(db),
  newId: () => `id${++n}`,
  nowMs: () => clock,
});
const search = (query: string, merchants = [A]): SearchRequest => ({
  sessionId: SESSION,
  query,
  merchants,
});

describe('what leaves without the owner', () => {
  it('a plain query goes, labelled derived; the owner’s own words, whole, are labelled quoted', () => {
    expect(checkSearch(search('green tea, loose leaf'), deps())).toMatchObject({
      ok: true,
      search: { query: 'green tea, loose leaf', merchants: [A], provenance: 'derived' },
    });
    log.recordUtterance(SESSION, 't1', 'green tea, loose leaf');
    expect(checkSearch(search('green tea, loose leaf'), deps())).toMatchObject({
      ok: true,
      search: { provenance: 'quoted' },
    });
  });

  it('merchants are de-duplicated, sorted and must be https origins; the query is bounded', () => {
    expect(checkSearch(search('tea', [B, `${A}/`, A]), deps())).toMatchObject({
      ok: true,
      search: { merchants: [A, B] },
    });
    expect(checkSearch(search('tea', ['http://a-shop.example']), deps())).toEqual({
      ok: false,
      reason: 'bad_merchants',
    });
    expect(checkSearch(search('tea', []), deps())).toEqual({ ok: false, reason: 'bad_merchants' });
    expect(checkSearch(search('x'.repeat(501)), deps())).toEqual({
      ok: false,
      reason: 'bad_query',
    });
    expect(checkSearch(search('   '), deps())).toEqual({ ok: false, reason: 'bad_query' });
  });
});

describe('what is held for the owner', () => {
  it('a query carrying a phone number', () => {
    expect(checkSearch(search('tea delivered to +1 415 555 0134'), deps())).toMatchObject({
      ok: false,
      reason: 'needs_review',
      why: ['personal_data'],
    });
  });

  it('any query in a conversation that read a private vault: two turns later, and 25 hours later', () => {
    queryVault(
      'health',
      { mode: 'fts5', text: 'cholesterol', limit: 5 },
      { sessionId: SESSION, audience: 'brain' },
    );
    expect(checkSearch(search('oat milk'), deps())).toMatchObject({
      ok: false,
      why: ['restricted_read'],
    });
    log.recordUtterance(SESSION, 't2', 'thanks');
    log.recordUtterance(SESSION, 't3', 'what else');
    expect(checkSearch(search('oat milk'), deps())).toMatchObject({
      ok: false,
      why: ['restricted_read'],
    });
    clock = NOW + RELEASE_LOG_TTL_MS + 60 * 60_000;
    log.purgeExpired();
    log.recordUtterance(SESSION, 't4', 'back again');
    expect(checkSearch(search('oat milk'), deps())).toMatchObject({
      ok: false,
      why: ['restricted_read'],
    });
  });

  it('any query from a conversation whose record is not known to be whole', () => {
    db.run(
      `INSERT INTO chat_messages (id, thread_id, type, content, metadata, sources, timestamp, data_scope)
       VALUES ('old', 'legacy', 'user', 'hi', '{}', '[]', 1, 'user')`,
    );
    log.recordUtterance('chat:legacy', 't1', 'hi');
    expect(
      checkSearch({ sessionId: 'chat:legacy', query: 'oat milk', merchants: [A] }, deps()),
    ).toMatchObject({
      ok: false,
      why: ['uncovered_conversation'],
    });
  });
});

describe('whose search it is', () => {
  it('a search needs the owner in the conversation now: a turn in the last half hour', () => {
    expect(checkSearch(search('oat milk'), deps())).toMatchObject({ ok: true });
    clock += 31 * 60_000;
    expect(checkSearch(search('oat milk'), deps())).toMatchObject({
      ok: false,
      reason: 'no_owner_turn',
    });
    log.recordUtterance(SESSION, 't9', 'and oat milk');
    expect(checkSearch(search('oat milk'), deps())).toMatchObject({ ok: true });
  });

  it('a session Brain names but Core holds no turn for searches nothing, and raises no card', () => {
    for (const sessionId of ['chat:made-up', 'ask:fresh', 'x']) {
      expect(checkSearch({ sessionId, query: 'oat milk', merchants: [A] }, deps())).toMatchObject({
        ok: false,
        reason: 'no_owner_turn',
      });
      expect(
        raiseSearchReview(
          { sessionId, query: 'tea for +1 415 555 0134', merchants: [A] },
          raiseDeps(),
        ),
      ).toEqual({
        ok: false,
        reason: 'no_owner_turn',
      });
    }
  });

  it('where chat lives in Brain (a server), a chat session is covered from its first turn, whatever Core holds', () => {
    // A server's Core may hold chat rows (an archive restored from a phone); the setting decides, not the table.
    const serverLog = new A2AReleaseLog(db, () => clock, { chatLivesIn: 'brain' });
    expect(readConversationTaint(db, serverLog, 'chat:on-server').covered).toBe(false);
    serverLog.recordUtterance('chat:on-server', 't1', 'find me green tea');
    expect(readConversationTaint(db, serverLog, 'chat:on-server').covered).toBe(true);
    expect(
      checkSearch(
        { sessionId: 'chat:on-server', query: 'green tea', merchants: [A] },
        { ...deps(), log: serverLog },
      ),
    ).toMatchObject({ ok: true });
  });

  it('where chat lives in Core (the phone), a first turn marks nothing, even with no chat yet', async () => {
    await chat.deleteThread('main');
    log.recordUtterance('chat:fresh', 't1', 'hi');
    expect(readConversationTaint(db, log, 'chat:fresh').covered).toBe(false);
  });

  it('where Core holds chat (the phone), a first turn marks nothing: an older thread stays uncovered', () => {
    db.run(
      `INSERT INTO chat_messages (id, thread_id, type, content, metadata, sources, timestamp, data_scope)
       VALUES ('old', 'legacy', 'user', 'hi', '{}', '[]', 1, 'user')`,
    );
    log.recordUtterance('chat:legacy', 't1', 'hi again');
    expect(readConversationTaint(db, log, 'chat:legacy').covered).toBe(false);
  });

  it('only a chat thread marked whole, or an ask the release log holds, is covered; any other session is not', () => {
    expect(readConversationTaint(db, log, SESSION).covered).toBe(true);
    expect(readConversationTaint(db, log, 'ask:never-seen').covered).toBe(false);
    log.recordUtterance('ask:known', 't1', 'tea');
    expect(readConversationTaint(db, log, 'ask:known').covered).toBe(true);
    log.recordUtterance('other:1', 't1', 'tea');
    expect(readConversationTaint(db, log, 'other:1').covered).toBe(false);
    expect(
      checkSearch({ sessionId: 'other:1', query: 'oat milk', merchants: [A] }, deps()),
    ).toMatchObject({
      ok: false,
      why: ['uncovered_conversation'],
    });
  });
});

describe('the owner’s card', () => {
  it('one live card per search: raising it again returns the same card; after it ends, a new one', () => {
    const held = search('tea for +1 415 555 0134', [B, A]);
    const first = raiseSearchReview(held, raiseDeps());
    const again = raiseSearchReview(held, raiseDeps());
    if (!first.ok || !again.ok) throw new Error('raise');
    expect(again).toEqual(first);
    const cards = () =>
      workflow
        .store()
        .listByKindAndState('approval', 'pending_approval', 100)
        .filter((t) => t.correlation_id === UCP_SEARCH_REVIEW_TYPE);
    expect(cards()).toHaveLength(1);
    // Approved and not yet used is still the live card.
    workflow.approve(first.reviewId);
    expect(raiseSearchReview(held, raiseDeps())).toEqual(first);
    workflow.cancel(first.reviewId, 'owner changed their mind');
    // After it ends, a new card once the owner asks again.
    clock += 1_000;
    log.recordUtterance(SESSION, 't8', 'go on then, search it');
    const next = raiseSearchReview(held, raiseDeps());
    if (!next.ok) throw new Error('raise');
    expect(next.reviewId).not.toBe(first.reviewId);
    // Another search (other merchants) is another card.
    const other = raiseSearchReview(search('tea for +1 415 555 0134', [C]), raiseDeps());
    if (!other.ok) throw new Error('raise');
    expect(other.reviewId).not.toBe(next.reviewId);
  });

  it('a card past its time but not yet swept is retired; raising again makes a new one', () => {
    const held = search('tea for +1 415 555 0134');
    const first = raiseSearchReview(held, raiseDeps());
    if (!first.ok) throw new Error('raise');
    clock += 61 * 60_000;
    log.recordUtterance(SESSION, 't8', 'still there?');
    const next = raiseSearchReview(held, raiseDeps());
    if (!next.ok) throw new Error('raise');
    expect(next.reviewId).not.toBe(first.reviewId);
    expect(next.expiresAtMs).toBeGreaterThan(clock);
    // Expired as the sweeper expires it: a lapse, not the owner's refusal.
    expect(workflow.store().getById(first.reviewId)?.status).toBe('failed');
  });

  it('the card’s own text names the whole query and every merchant', () => {
    const long = `${'green tea '.repeat(20)}to +1 415 555 0134`;
    const raised = raiseSearchReview(search(long, [C, A, B]), raiseDeps());
    if (!raised.ok) throw new Error('raise');
    const task = workflow.store().getById(raised.reviewId);
    expect(task?.description).toBe(`Search ${A}, ${B}, ${C} for: ${long.trim()}`);
  });

  it('a three-merchant search from a tainted conversation raises ONE card naming the query and every merchant', () => {
    queryVault(
      'health',
      { mode: 'fts5', text: 'cholesterol', limit: 5 },
      { sessionId: SESSION, audience: 'brain' },
    );
    const raised = raiseSearchReview(search('oat milk', [C, A, B]), raiseDeps());
    expect(raised).toMatchObject({ ok: true });
    if (!raised.ok) return;
    const tasks = workflow
      .store()
      .listByKindAndState('approval', 'pending_approval', 100)
      .filter((t) => t.correlation_id === UCP_SEARCH_REVIEW_TYPE);
    expect(tasks).toHaveLength(1);
    expect(JSON.parse(tasks[0]?.payload as string)).toMatchObject({
      type: UCP_SEARCH_REVIEW_TYPE,
      query: 'oat milk',
      merchants: [A, B, C],
      why: ['restricted_read'],
    });
    expect(tasks[0]?.status).toBe('pending_approval');
    expect(raised.reviewId.startsWith('ucp-')).toBe(true);
  });

  it('no card for a search that needs none', () => {
    expect(raiseSearchReview(search('oat milk'), raiseDeps())).toEqual({
      ok: false,
      reason: 'not_needed',
    });
  });

  it('an approved card sends exactly its search, once; a changed query or another merchant is refused', () => {
    const held = search('tea to +1 415 555 0134', [A, B]);
    const raised = raiseSearchReview(held, raiseDeps());
    if (!raised.ok) throw new Error('raise');
    const projected = (q: SearchRequest) => {
      const c = checkSearch(q, deps());
      if (c.ok || c.reason !== 'needs_review') throw new Error('expected a held search');
      return c.search;
    };
    const use = (q: SearchRequest) =>
      useSearchReview(raised.reviewId, projected(q), SESSION, { workflow, nowMs: () => clock });
    expect(use(held)).toEqual({ ok: false, reason: 'pending' });
    workflow.approve(raised.reviewId);
    expect(use(search('tea to +1 415 555 0199', [A, B]))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(use(search('tea to +1 415 555 0134', [A, B, C]))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(use(search('tea to +1 415 555 0134', [B, A]))).toEqual({ ok: true });
    expect(use(held)).toEqual({ ok: false, reason: 'used' });
  });

  it('after a decline, no card in the conversation (reworded, or other shops) until the owner speaks', () => {
    const declined = raiseSearchReview(search('tea to +1 415 555 0134', [A]), raiseDeps());
    if (!declined.ok) throw new Error('raise');
    clock += 1_000;
    workflow.cancel(declined.reviewId, 'denied_by_operator');
    for (const near of [
      search('tea to +1 415 555 0134', [B]),
      search('green tea, call +1 415 555 0134', [A]),
    ]) {
      expect(raiseSearchReview(near, raiseDeps())).toEqual({
        ok: false,
        reason: 'review_declined',
      });
    }
    clock += 1_000;
    log.recordUtterance(SESSION, 't7', 'try the other shop then');
    expect(raiseSearchReview(search('tea to +1 415 555 0134', [B]), raiseDeps())).toMatchObject({
      ok: true,
    });
    // Another conversation was never declined.
    log.recordUtterance('chat:other', 'o1', 'tea please');
    expect(
      raiseSearchReview(
        { sessionId: 'chat:other', query: 'tea to +1 415 555 0134', merchants: [A] },
        raiseDeps(),
      ),
    ).toMatchObject({ ok: true });
  });

  it('at most three cards wait on the owner in one conversation; asking for one of them again returns it', () => {
    const raised = ['one', 'two', 'three'].map((w) =>
      raiseSearchReview(search(`${w} tea to +1 415 555 0134`, [A]), raiseDeps()),
    );
    expect(raised.every((r) => r.ok)).toBe(true);
    expect(raiseSearchReview(search('four teas to +1 415 555 0134', [A]), raiseDeps())).toEqual({
      ok: false,
      reason: 'too_many_reviews',
    });
    expect(raiseSearchReview(search('two tea to +1 415 555 0134', [A]), raiseDeps())).toEqual(
      raised[1],
    );
    // One decided frees a place.
    const first = raised[0];
    if (first === undefined || !first.ok) throw new Error('raise');
    workflow.approve(first.reviewId);
    expect(
      raiseSearchReview(search('four teas to +1 415 555 0134', [A]), raiseDeps()),
    ).toMatchObject({ ok: true });
  });

  it('an approved card stays usable for its hour: approved at minute 12, used at minute 16', () => {
    const held = search('tea to +1 415 555 0134');
    const raised = raiseSearchReview(held, raiseDeps());
    if (!raised.ok) throw new Error('raise');
    clock += 12 * 60_000;
    workflow.approve(raised.reviewId);
    clock += 4 * 60_000;
    workflow.expireTasks(Math.floor(clock / 1000), clock);
    const c = checkSearch(held, deps());
    if (c.ok || c.reason !== 'needs_review') throw new Error('held');
    expect(
      useSearchReview(raised.reviewId, c.search, SESSION, { workflow, nowMs: () => clock }),
    ).toEqual({ ok: true });
  });

  it('a declined or expired card sends nothing', () => {
    const held = search('tea to +1 415 555 0134');
    const declined = raiseSearchReview(held, raiseDeps());
    if (!declined.ok) throw new Error('raise');
    clock += 1_000;
    workflow.cancel(declined.reviewId, 'no');
    // The owner said no: Brain cannot raise the same search again on its own say.
    expect(raiseSearchReview(held, raiseDeps())).toEqual({ ok: false, reason: 'review_declined' });
    // Once the owner speaks again (asks for it in their own words), it may.
    clock += 1_000;
    log.recordUtterance(SESSION, 't9', 'yes, send it with the number after all');
    const expired = raiseSearchReview(held, raiseDeps());
    if (!expired.ok) throw new Error('raise');
    workflow.approve(expired.reviewId);
    const c = checkSearch(held, deps());
    if (c.ok || c.reason !== 'needs_review') throw new Error('held');
    expect(
      useSearchReview(declined.reviewId, c.search, SESSION, { workflow, nowMs: () => clock }),
    ).toEqual({ ok: false, reason: 'declined' });
    clock += 2 * 60 * 60_000;
    expect(
      useSearchReview(expired.reviewId, c.search, SESSION, { workflow, nowMs: () => clock }),
    ).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('what Brain cannot do with the card', () => {
  function call(
    caller: 'brain' | 'owner',
    method: CoreRequest['method'],
    p: string,
    body: Record<string, unknown> = {},
  ) {
    const router = new CoreRouter();
    registerWorkflowRoutes(router, 'cap');
    return router.handle({
      method,
      path: p,
      query: {},
      headers: { 'x-did': 'did:key:brain' },
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: caller,
      callerDID: 'did:key:brain',
      ...(caller === 'owner' ? { ownerCapability: 'cap' } : {}),
    } as CoreRequest);
  }

  it('create one, decide one, or move one after the owner said yes', async () => {
    const minted = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'x1',
      kind: 'approval',
      description: 'x',
      payload: JSON.stringify({ type: UCP_SEARCH_REVIEW_TYPE }),
    });
    expect((minted.body as { error: string }).error).toBe('reserved_payload_type');
    const squat = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'ucp-search-review-x',
      kind: 'approval',
      description: 'x',
      payload: '{}',
    });
    expect((squat.body as { error: string }).error).toBe('reserved_task_id');
    const raised = raiseSearchReview(search('tea to +1 415 555 0134'), raiseDeps());
    if (!raised.ok) throw new Error('raise');
    for (const verb of ['approve', 'cancel', 'fail']) {
      expect(
        (await call('brain', 'POST', `/v1/workflow/tasks/${raised.reviewId}/${verb}`)).status,
      ).toBe(403);
    }
    expect(
      (await call('owner', 'POST', `/v1/workflow/tasks/${raised.reviewId}/approve`)).status,
    ).toBe(200);
    for (const verb of ['complete', 'fail', 'heartbeat', 'progress']) {
      expect(
        (
          await call('brain', 'POST', `/v1/workflow/tasks/${raised.reviewId}/${verb}`, {
            result: '{}',
          })
        ).status,
      ).toBe(403);
    }
    expect(workflow.store().getById(raised.reviewId)?.status).toBe('queued');
  });
});
