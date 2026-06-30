/**
 * Owner-private decision log — prompt-lifecycle honesty (CONTACT review P2 #3/#4/#5).
 *
 * The `ask_to_enable` path is logged from the MOBILE surface that owns the
 * prompt, NOT optimistically from Core:
 *   - `prompt_shown`     — only when the card is DURABLY posted (and once, even
 *                          across a grant_request retry — idempotent).
 *   - `granted`          — when the owner taps Allow.
 *   - `prompt_timed_out` — when the owner taps "Not now".
 *
 * These pin that the writers record the right row AND that `postGrantPromptOnce`
 * never logs a prompt that wasn't actually shown / double-logs a retry.
 */

import {
  setServiceDecisionRepository,
  type ServiceDecision,
  type ServiceDecisionInput,
  type ServiceDecisionRepository,
} from '@dina/core/storage';

import { getThread, hydrateThread, resetThreads } from '../../../brain/src/chat/thread';
import { InMemoryChatMessageRepository, setChatMessageRepository } from '../../../core/src/index';
import {
  recordPromptShown,
  recordPromptGranted,
  recordPromptDismissed,
} from '../../src/services/grant_decision_log';
import { postGrantPromptOnce } from '../../src/services/grant_prompt';

const PEER = 'did:plc:sancho';
const CAP = 'availability_coordination';
const RKEY = 'avail-1';

class FakeDecisionRepo implements ServiceDecisionRepository {
  rows: ServiceDecision[] = [];
  record(entry: ServiceDecisionInput): void {
    this.rows.push({ id: this.rows.length + 1, reason: '', ...entry });
  }
  list(limit = 100): ServiceDecision[] {
    return [...this.rows].reverse().slice(0, limit);
  }
}

let decisionRepo: FakeDecisionRepo;
let chatRepo: InMemoryChatMessageRepository;

beforeEach(() => {
  decisionRepo = new FakeDecisionRepo();
  setServiceDecisionRepository(decisionRepo);
  chatRepo = new InMemoryChatMessageRepository();
  setChatMessageRepository(chatRepo);
  resetThreads();
});

afterEach(() => {
  setServiceDecisionRepository(null);
  setChatMessageRepository(null);
});

describe('grant_decision_log writers', () => {
  it('recordPromptShown writes prompt_shown with the closeness tier', () => {
    recordPromptShown(PEER, CAP, 'medium');
    expect(decisionRepo.rows).toHaveLength(1);
    expect(decisionRepo.rows[0]).toMatchObject({
      requesterDid: PEER,
      capability: CAP,
      decision: 'prompt_shown',
      reason: 'closeness=medium',
    });
  });

  it('recordPromptGranted writes granted (owner_allowed)', () => {
    recordPromptGranted(PEER, CAP);
    expect(decisionRepo.rows[0]).toMatchObject({ decision: 'granted', reason: 'owner_allowed' });
  });

  it('recordPromptDismissed writes prompt_timed_out (owner_dismissed)', () => {
    recordPromptDismissed(PEER, CAP);
    expect(decisionRepo.rows[0]).toMatchObject({
      decision: 'prompt_timed_out',
      reason: 'owner_dismissed',
    });
  });

  it('is a no-op (never throws) when no repo is wired', () => {
    setServiceDecisionRepository(null);
    expect(() => recordPromptGranted(PEER, CAP)).not.toThrow();
  });
});

describe('postGrantPromptOnce — honest prompt_shown', () => {
  it('records prompt_shown exactly once, only when the card is actually posted', async () => {
    await postGrantPromptOnce(PEER, CAP, RKEY, 'medium');
    // A retry (same requester+capability) must reuse the card AND not re-log.
    await postGrantPromptOnce(PEER, CAP, RKEY, 'medium');

    expect(getThread(PEER)).toHaveLength(1); // one card
    const shown = decisionRepo.rows.filter((r) => r.decision === 'prompt_shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ requesterDid: PEER, capability: CAP, reason: 'closeness=medium' });
  });

  it('does NOT log prompt_shown for a rehydrated card that was never re-posted', async () => {
    await postGrantPromptOnce(PEER, CAP, RKEY, 'medium');
    // Simulate a restart: drop in-memory, keep the persisted card, rehydrate.
    await Promise.resolve();
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(chatRepo);
    await hydrateThread(PEER);
    decisionRepo.rows = []; // forget the first session's log

    // The retry finds the rehydrated card and skips — so NO new prompt_shown.
    await postGrantPromptOnce(PEER, CAP, RKEY, 'medium');
    expect(decisionRepo.rows).toHaveLength(0);
  });
});
