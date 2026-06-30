/**
 * Contact Services `ask_to_enable` prompt — durability + idempotency (P1 + P2-4).
 *
 * The prompt must survive an app restart AND a lazy-hydration race correctly:
 *   - posting is IDEMPOTENT on (requesterDID, capability) — it HYDRATES the
 *     contact's thread from the repo first, then scans, so a `service.grant_request`
 *     retry that arrives BEFORE the peer chat is opened (in-memory thread empty,
 *     prior card only on disk) does NOT stack a duplicate;
 *   - a DISMISSED/ALLOWED (requester, capability) rehydrates terminal — the
 *     owner is never re-prompted for something already resolved.
 *
 * A "restart" is faithfully simulated the way the chat layer's own persistence
 * test does it: `resetThreads()` (clears in-memory state — the boot closure's
 * de-dup Set is gone with it) then `await hydrateThread(thread)` (pulls the
 * persisted rows back from the `ChatMessageRepository`).
 */

import { getThread, hydrateThread, resetThreads } from '../../../brain/src/chat/thread';
import { InMemoryChatMessageRepository, setChatMessageRepository } from '../../../core/src/index';
import {
  postGrantPromptOnce,
  resolveGrantPrompt,
  findGrantPrompt,
  readGrantPromptLifecycle,
} from '../../src/services/grant_prompt';

const PEER = 'did:plc:sancho';
const CAP = 'availability_coordination';
const RKEY = 'avail-1';

let repo: InMemoryChatMessageRepository;

beforeEach(() => {
  repo = new InMemoryChatMessageRepository();
  setChatMessageRepository(repo);
  resetThreads();
});

afterEach(() => {
  setChatMessageRepository(null);
});

/** Simulate an app restart: the in-memory cache (+ any boot closure de-dup
 *  Set) goes away, but the persisted repo survives (SQLite in production). We
 *  unset the global repo ref BEFORE resetThreads so the reset doesn't ALSO wipe
 *  the persisted rows, then rehook + hydrate — the pattern thread_persistence
 *  uses. Flush pending fire-and-forget persists first so the rows are on disk. */
async function restart(threadId: string): Promise<void> {
  await Promise.resolve(); // let any fire-and-forget repo.append() settle
  setChatMessageRepository(null);
  resetThreads();
  setChatMessageRepository(repo);
  await hydrateThread(threadId);
}

/** Simulate the LAZY-HYDRATION race: the persisted rows survive, the in-memory
 *  thread is cleared, but the peer chat was NEVER opened this session — so the
 *  thread is NOT pre-hydrated. `postGrantPromptOnce` must hydrate it itself. */
async function dropInMemoryButKeepRepo(): Promise<void> {
  await Promise.resolve();
  setChatMessageRepository(null);
  resetThreads();
  setChatMessageRepository(repo);
  // NOTE: deliberately NO hydrateThread — the peer chat is un-opened.
}

describe('grant_prompt — idempotent post', () => {
  it('posts exactly one card and reuses it on a second emit in-session', async () => {
    const a = await postGrantPromptOnce(PEER, CAP, RKEY);
    const b = await postGrantPromptOnce(PEER, CAP, RKEY);
    expect(a).not.toBeNull();
    expect(b?.id).toBe(a?.id); // reused, not a new row
    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(1);
  });

  it('does NOT stack a second card after a restart + requester retry', async () => {
    await postGrantPromptOnce(PEER, CAP, RKEY);
    await restart(PEER);

    // The card rehydrated; the requester's normal grant_request retry fires
    // `postGrantPromptOnce` again — it must find the rehydrated card and skip.
    await postGrantPromptOnce(PEER, CAP, RKEY);

    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(1);
    expect(readGrantPromptLifecycle(prompts[0])?.status).toBe('pending');
  });

  it('does NOT stack on a retry that arrives BEFORE the peer thread is opened (P2-4 lazy-hydrate race)', async () => {
    await postGrantPromptOnce(PEER, CAP, RKEY);
    // The peer chat was never opened: in-memory thread cleared, repo intact, NO
    // pre-hydration. A naive in-memory-only scan would see an empty thread here
    // and stack a duplicate.
    await dropInMemoryButKeepRepo();
    expect(getThread(PEER)).toHaveLength(0); // un-hydrated in memory

    await postGrantPromptOnce(PEER, CAP, RKEY);

    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(1); // hydrated-then-scanned → no duplicate
  });

  it('does NOT re-prompt a DISMISSED card on a retry before the peer thread is opened (P2-4)', async () => {
    const card = await postGrantPromptOnce(PEER, CAP, RKEY);
    if (card === null) throw new Error('expected a posted card');
    resolveGrantPrompt(PEER, card.id, 'dismissed');

    await dropInMemoryButKeepRepo();
    expect(getThread(PEER)).toHaveLength(0);

    // Inbound retry before the chat is opened — must hydrate, see the dismissed
    // card, and skip (no new prompt, status stays dismissed).
    await postGrantPromptOnce(PEER, CAP, RKEY);

    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(1);
    expect(readGrantPromptLifecycle(prompts[0])?.status).toBe('dismissed');
  });

  it('treats a DIFFERENT capability as a distinct prompt', async () => {
    await postGrantPromptOnce(PEER, CAP, RKEY);
    await postGrantPromptOnce(PEER, 'introductions', 'intro-1');
    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(2);
  });

  it('treats a DIFFERENT listing (rkey) for the same capability as distinct (#7)', async () => {
    // An old terminal prompt for one talk listing must NOT suppress a fresh
    // prompt when the capability is later served by a different listing (rkey).
    const first = await postGrantPromptOnce(PEER, CAP, RKEY);
    if (first === null) throw new Error('expected a posted card');
    resolveGrantPrompt(PEER, first.id, 'dismissed');

    await postGrantPromptOnce(PEER, CAP, 'avail-2');

    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(2);
    expect(prompts.map((m) => readGrantPromptLifecycle(m)?.rkey).sort()).toEqual([RKEY, 'avail-2'].sort());
  });

  it('rejects degenerate inputs (empty did/capability/rkey)', async () => {
    expect(await postGrantPromptOnce('', CAP, RKEY)).toBeNull();
    expect(await postGrantPromptOnce(PEER, '', RKEY)).toBeNull();
    expect(await postGrantPromptOnce(PEER, CAP, '')).toBeNull();
    expect(getThread(PEER)).toHaveLength(0);
  });
});

describe('grant_prompt — persisted resolution survives restart', () => {
  it('a dismissed prompt rehydrates terminal and is NOT re-prompted', async () => {
    const card = await postGrantPromptOnce(PEER, CAP, RKEY);
    if (card === null) throw new Error('expected a posted card');

    // "Not now" — persist the terminal status (no backend call here; that is
    // the card's §2 invariant, exercised separately).
    const patched = resolveGrantPrompt(PEER, card.id, 'dismissed');
    expect(patched).not.toBeNull();
    expect(patched && readGrantPromptLifecycle(patched)?.status).toBe('dismissed');

    await restart(PEER);

    // The rehydrated card is terminal...
    const rehydrated = findGrantPrompt(PEER, CAP);
    if (rehydrated === null) throw new Error('expected the rehydrated card');
    expect(readGrantPromptLifecycle(rehydrated)?.status).toBe('dismissed');

    // ...and a retry does NOT re-prompt (no new card, status stays dismissed).
    await postGrantPromptOnce(PEER, CAP, RKEY);
    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(1);
    expect(readGrantPromptLifecycle(prompts[0])?.status).toBe('dismissed');
  });

  it('an allowed prompt rehydrates terminal and is NOT re-prompted', async () => {
    const card = await postGrantPromptOnce(PEER, CAP, RKEY);
    if (card === null) throw new Error('expected a posted card');
    resolveGrantPrompt(PEER, card.id, 'allowed');
    await restart(PEER);

    const rehydrated = findGrantPrompt(PEER, CAP);
    if (rehydrated === null) throw new Error('expected the rehydrated card');
    expect(readGrantPromptLifecycle(rehydrated)?.status).toBe('allowed');

    await postGrantPromptOnce(PEER, CAP, RKEY);
    const prompts = getThread(PEER).filter((m) => readGrantPromptLifecycle(m) !== null);
    expect(prompts).toHaveLength(1);
  });

  it('resolveGrantPrompt returns null for an unknown message id', async () => {
    await postGrantPromptOnce(PEER, CAP, RKEY);
    expect(resolveGrantPrompt(PEER, 'cm-nonexistent', 'dismissed')).toBeNull();
  });
});

describe('grant_prompt — readGrantPromptLifecycle validation', () => {
  it('defaults an absent status to pending (legacy rows)', async () => {
    const card = await postGrantPromptOnce(PEER, CAP, RKEY);
    if (card === null) throw new Error('expected a posted card');
    // Simulate a legacy row by deleting status — re-read tolerates it.
    const lifecycle = card.metadata?.lifecycle as Record<string, unknown> | undefined;
    if (lifecycle === undefined) throw new Error('expected a lifecycle');
    delete lifecycle.status;
    expect(readGrantPromptLifecycle(card)?.status).toBe('pending');
  });

  it('returns null for a non-grant_request_prompt message', async () => {
    const { addMessage } = await import('../../../brain/src/chat/thread');
    const m = addMessage(PEER, 'dina', 'hi', { metadata: { source: 'd2d' } });
    expect(readGrantPromptLifecycle(m)).toBeNull();
  });
});
