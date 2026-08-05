/**
 * T6.19 — D2D message view: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 6.19
 */

import { makeFakePeopleRepo } from '@dina/test-harness';

import { getThread, resetThreads } from '../../../brain/src/chat/thread';
import {
  addContact,
  getContact,
  resetContactDirectory,
  setPeopleRepository,
} from '../../../core/src';
import {
  setContactRepository,
  type ContactRepository,
} from '../../../core/src/contacts/repository';
import { clearGatesState } from '../../../core/src/d2d/gates';
import { quarantineMessage } from '../../../core/src/d2d/quarantine';
import {
  InMemoryStagingRepository,
  setStagingRepository,
} from '../../../core/src/staging/repository';
import { claim, resetStagingState } from '../../../core/src/staging/service';
import {
  getQuarantinedMessages,
  acceptFromQuarantine,
  blockFromQuarantine,
  composeReply,
  getQuarantineBadge,
  registerSenderLabel,
  resetD2DMessages,
} from '../../src/hooks/useD2DMessages';

/**
 * A contact repository whose durable `update()` throws (e.g. disk failure)
 * but whose `add()` succeeds — so an INSERT (new contact) works while an
 * UPDATE (trust upgrade on an existing contact) fails. Used to prove Accept
 * does not release a message on a failed trust upgrade.
 */
function makeFailingUpdateContactRepo(): ContactRepository {
  const noop = (): void => {
    /* this test repository intentionally discards successful writes */
  };
  return {
    add: noop,
    get: () => null,
    list: () => [],
    update: () => {
      throw new Error('simulated durable write failure');
    },
    remove: () => false,
    addAlias: noop,
    removeAlias: noop,
    resolveAlias: () => null,
    getAliases: () => [],
    setPreferredFor: noop,
    getPreferredFor: () => [],
    findByPreferredFor: () => [],
  };
}

class FailSecondStagingIngestRepository extends InMemoryStagingRepository {
  private ingestCalls = 0;

  override ingest(item: Parameters<InMemoryStagingRepository['ingest']>[0]): boolean {
    this.ingestCalls += 1;
    if (this.ingestCalls === 2) throw new Error('simulated second staging write failure');
    return super.ingest(item);
  }
}

describe('D2D Message View Hook (6.19)', () => {
  beforeEach(() => {
    resetD2DMessages();
    resetThreads();
  });

  describe('quarantined messages', () => {
    it('returns empty when no quarantined messages', () => {
      expect(getQuarantinedMessages()).toHaveLength(0);
    });

    it('lists quarantined messages with sender info', () => {
      quarantineMessage('did:key:z6MkAlice', 'social.update', 'Hello from Alice');
      registerSenderLabel('did:key:z6MkAlice', 'Alice');

      const msgs = getQuarantinedMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].senderLabel).toBe('Alice');
      expect(msgs[0].messageType).toBe('social.update');
      expect(msgs[0].isQuarantined).toBe(true);
      expect(msgs[0].trustLevel).toBe('unknown');
    });

    it('shortens DID when no label registered', () => {
      quarantineMessage('did:key:z6MkLongDIDStringHere1234567890', 'social.update', 'Hi');

      const msgs = getQuarantinedMessages();
      expect(msgs[0].senderLabel).toContain('...');
    });
  });

  describe('acceptFromQuarantine', () => {
    // Accept now REQUIRES a working contact directory — it persists the sender
    // as a contact and only releases the held message once that succeeds.
    beforeEach(() => {
      resetContactDirectory();
      clearGatesState();
      resetStagingState();
      setPeopleRepository(makeFakePeopleRepo());
    });

    it('accepts a quarantined message', () => {
      const q = quarantineMessage('did:key:z6MkAlice', 'social.update', 'Hello');

      const result = acceptFromQuarantine(q.id);
      expect(result.action).toBe('accepted');
      expect(result.senderDID).toBe('did:key:z6MkAlice');
    });

    it('returns error for nonexistent quarantine', () => {
      const result = acceptFromQuarantine('nonexistent');
      expect(result.action).toBe('error');
    });

    // Finding #1: an EXISTING 'unknown' contact (the state that causes
    // quarantine) must be UPGRADED to verified on accept — not left unknown,
    // which would re-quarantine their next message forever. addContact() throws
    // on an existing policy, so this only works via the update path.
    it('upgrades an existing unknown contact to verified', () => {
      const sender = 'did:plc:existingunknownaccept';
      addContact(sender, 'Existing', 'unknown');
      expect(getContact(sender)?.trustLevel).toBe('unknown');

      const q = quarantineMessage(sender, 'social.update', JSON.stringify({ text: 'hi' }));
      const result = acceptFromQuarantine(q.id);
      expect(result.action).toBe('accepted');
      expect(getContact(sender)?.trustLevel).toBe('verified');
    });

    // Finding #3: a genuine contact-persist failure (NEW contact can't be
    // created) must NOT silently release the message.
    it('does NOT release the message when the contact cannot be persisted', () => {
      setPeopleRepository(null); // contact directory unavailable → addContact throws
      const q = quarantineMessage(
        'did:plc:persistfail',
        'social.update',
        JSON.stringify({ text: 'hi' }),
      );
      const result = acceptFromQuarantine(q.id);
      expect(result.action).toBe('error');
      // The message stays quarantined — not force-staged with a phantom trust.
      expect(getQuarantinedMessages().some((m) => m.id === q.id)).toBe(true);
    });

    // Finding #1 (round 3): an EXISTING unknown contact whose trust-upgrade
    // WRITE fails must NOT release — the contact stays non-null but 'unknown',
    // so a getContact !== null check is insufficient; require trust='verified'.
    it('does NOT release when the trust upgrade write fails (stays unknown + quarantined)', () => {
      const sender = 'did:plc:upgradewritefail';
      try {
        setContactRepository(makeFailingUpdateContactRepo());
        addContact(sender, 'Existing', 'unknown'); // INSERT (add) ok → cached unknown
        expect(getContact(sender)?.trustLevel).toBe('unknown');

        const q = quarantineMessage(sender, 'social.update', JSON.stringify({ text: 'hi' }));
        const result = acceptFromQuarantine(q.id); // UPDATE (upgrade) throws

        expect(result.action).toBe('error');
        expect(getContact(sender)?.trustLevel).toBe('unknown'); // upgrade didn't stick
        expect(getQuarantinedMessages().some((m) => m.id === q.id)).toBe(true); // not released
      } finally {
        setContactRepository(null);
      }
    });

    it('keeps every held row retryable when staging fails part-way through', () => {
      const sender = 'did:plc:partialstagingfailure';
      const repo = new FailSecondStagingIngestRepository();
      setStagingRepository(repo);
      quarantineMessage(sender, 'social.update', JSON.stringify({ text: 'first' }), 1);
      const second = quarantineMessage(
        sender,
        'social.update',
        JSON.stringify({ text: 'second' }),
        2,
      );

      try {
        const failed = acceptFromQuarantine(second.id);
        expect(failed.action).toBe('error');
        expect(getQuarantinedMessages()).toHaveLength(2);

        // The first write deduplicates on retry; the previously failing second
        // write succeeds, and only then are both durable quarantine rows removed.
        const retried = acceptFromQuarantine(second.id);
        expect(retried.action).toBe('accepted');
        expect(getQuarantinedMessages()).toHaveLength(0);
        expect(claim(10)).toHaveLength(2);
      } finally {
        resetStagingState();
        setStagingRepository(null);
      }
    });
  });

  // Regression contract for the two bugs the live two-Dina Talk run exposed
  // (see project_d2d_talk_live_test / docs MRS-05):
  //   1. acceptFromQuarantine only un-quarantined — it never recorded the
  //      sender as a contact, so resolveSender returned 'unknown' on their
  //      NEXT message and it re-quarantined forever.
  //   2. The released message was re-staged WITHOUT isContact=true, so
  //      receiveAndStage re-quarantined it (the known-sender gate is the
  //      6th param, not the senderTrust string).
  describe('acceptFromQuarantine — contract (records contact + releases for drain)', () => {
    beforeEach(() => {
      resetContactDirectory();
      clearGatesState();
      resetStagingState();
      setPeopleRepository(makeFakePeopleRepo());
    });

    it('records the sender as a verified contact and re-stages the held message (not re-quarantined)', () => {
      const sender = 'did:plc:alonsosanitycheck';
      const q = quarantineMessage(
        sender,
        'social.update',
        JSON.stringify({ text: "I'm coming over tomorrow morning" }),
      );

      const result = acceptFromQuarantine(q.id);
      expect(result.action).toBe('accepted');

      // (1) sender is now a known, VERIFIED contact — so their next message
      // resolves to a positive trust and stages directly instead of looping
      // back into quarantine.
      const contact = getContact(sender);
      expect(contact).not.toBeNull();
      expect(contact?.trustLevel).toBe('verified');

      // (1b) the held message left the quarantine store.
      expect(getQuarantinedMessages()).toHaveLength(0);

      // (2) the released message was STAGED (claimable by the drain), NOT
      // re-quarantined. Before the isContact=true fix this list was empty.
      const staged = claim(10);
      expect(staged.length).toBeGreaterThanOrEqual(1);
      expect(staged.some((s) => s.producer_id === sender)).toBe(true);
    });
  });

  describe('blockFromQuarantine', () => {
    beforeEach(() => {
      resetContactDirectory();
      clearGatesState();
      setPeopleRepository(makeFakePeopleRepo());
    });

    it('blocks a quarantined sender', () => {
      const q = quarantineMessage('did:key:z6MkSpam', 'promo.offer', 'Buy now');

      const result = blockFromQuarantine(q.id);
      expect(result.action).toBe('blocked');
      expect(result.senderDID).toBe('did:key:z6MkSpam');
    });

    it('returns error for nonexistent', () => {
      const result = blockFromQuarantine('nonexistent');
      expect(result.action).toBe('error');
    });

    // Finding #2: block must persist a durable 'blocked' contact so the
    // receive pipeline drops FUTURE messages (not just delete current rows).
    it('persists a blocked contact so future messages are dropped', () => {
      const sender = 'did:key:z6MkSpamDurable';
      const q = quarantineMessage(sender, 'social.update', 'spam');
      const result = blockFromQuarantine(q.id);
      expect(result.action).toBe('blocked');
      const contact = getContact(sender);
      expect(contact?.trustLevel).toBe('blocked');
    });

    // Finding #1: blocking an EXISTING 'unknown' contact must update it to
    // 'blocked' (addContact would throw already-exists and fail the block).
    it('blocks an existing unknown contact instead of failing', () => {
      const sender = 'did:plc:existingunknownblock';
      addContact(sender, 'Existing', 'unknown');
      const q = quarantineMessage(sender, 'social.update', 'spam');
      const result = blockFromQuarantine(q.id);
      expect(result.action).toBe('blocked');
      expect(getContact(sender)?.trustLevel).toBe('blocked');
    });
  });

  describe('composeReply', () => {
    it('adds reply to chat thread', () => {
      const reply = composeReply('did:key:z6MkAlice', 'Thanks for the message!', 'main');

      expect(reply.type).toBe('user');
      expect(reply.content).toBe('Thanks for the message!');

      const thread = getThread('main');
      expect(thread).toHaveLength(1);
    });
  });

  describe('getQuarantineBadge', () => {
    it('returns 0 when empty', () => {
      expect(getQuarantineBadge()).toBe(0);
    });

    it('counts quarantined messages', () => {
      quarantineMessage('did:key:z6MkA', 'social.update', 'a');
      quarantineMessage('did:key:z6MkB', 'social.update', 'b');
      expect(getQuarantineBadge()).toBe(2);
    });
  });

  describe('time formatting', () => {
    it('formats recent message as "Just now"', () => {
      quarantineMessage('did:key:z6MkA', 'social.update', 'test');
      const msgs = getQuarantinedMessages();
      expect(msgs[0].timeLabel).toBe('Just now');
    });
  });
});
