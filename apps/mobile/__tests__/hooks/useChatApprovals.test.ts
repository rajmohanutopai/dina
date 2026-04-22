/**
 * T4.11 — Chat approval cards: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.11
 */

import {
  createApprovalCard,
  approveCard,
  denyCard,
  getPendingCards,
  getCard,
  getPendingCount,
  isApproved,
  consumeApproval,
  endSession,
  registerDIDLabel,
  resetApprovalCards,
} from '../../src/hooks/useChatApprovals';
import { resetThreads } from '../../../brain/src/chat/thread';

const BRAIN_DID = 'did:key:z6MkBrainTest';
const USER_DID = 'did:key:z6MkUserDevice';

describe('Chat Approval Cards Hook (4.11)', () => {
  beforeEach(() => {
    resetApprovalCards();
    resetThreads();
  });

  describe('createApprovalCard', () => {
    it('creates a pending approval card', () => {
      const card = createApprovalCard(
        'apr-1',
        'unlock_persona',
        BRAIN_DID,
        'health',
        'Need to access health records',
        'Accessing health vault',
      );

      expect(card.id).toBe('apr-1');
      expect(card.action).toBe('unlock_persona');
      expect(card.persona).toBe('health');
      expect(card.reason).toContain('health records');
      expect(card.preview).toContain('health vault');
      expect(card.status).toBe('pending');
    });

    it('shows DID label when registered', () => {
      registerDIDLabel(BRAIN_DID, 'Brain');

      const card = createApprovalCard(
        'apr-2',
        'share_data',
        BRAIN_DID,
        'general',
        'Sharing with contact',
        '',
      );

      expect(card.requesterLabel).toBe('Brain');
    });

    it('shows short DID when no label', () => {
      const card = createApprovalCard(
        'apr-3',
        'test',
        'did:key:z6MkLongDIDStringHere1234567890',
        'general',
        '',
        '',
      );

      expect(card.requesterLabel).toContain('did:key:');
      expect(card.requesterLabel).toContain('...');
    });

    it('adds approval message to chat thread', () => {
      createApprovalCard('apr-4', 'test', BRAIN_DID, 'general', 'reason', 'preview', 'main');

      const { getThread } = require('../../../brain/src/chat/thread');
      const messages = getThread('main');
      const approvalMsg = messages.find((m: any) => m.type === 'approval');
      expect(approvalMsg).toBeDefined();
    });
  });

  describe('approveCard', () => {
    beforeEach(() => {
      createApprovalCard('apr-1', 'unlock', BRAIN_DID, 'health', 'reason', 'preview');
    });

    it('approves with single scope', () => {
      const card = approveCard('apr-1', 'single', USER_DID);

      expect(card).not.toBeNull();
      expect(card!.status).toBe('approved');
      expect(card!.scope).toBe('single');
    });

    it('approves with session scope', () => {
      const card = approveCard('apr-1', 'session', USER_DID);

      expect(card!.status).toBe('approved');
      expect(card!.scope).toBe('session');
    });

    it('returns null for nonexistent approval', () => {
      expect(approveCard('nonexistent', 'single', USER_DID)).toBeNull();
    });

    it('approved request is no longer in pending list', () => {
      expect(getPendingCount()).toBe(1);
      approveCard('apr-1', 'single', USER_DID);
      expect(getPendingCount()).toBe(0);
    });
  });

  describe('denyCard', () => {
    beforeEach(() => {
      createApprovalCard('apr-1', 'share', BRAIN_DID, 'general', 'reason', 'preview');
    });

    it('denies a pending request', () => {
      const card = denyCard('apr-1');

      expect(card).not.toBeNull();
      expect(card!.status).toBe('denied');
    });

    it('removes from pending list', () => {
      expect(getPendingCount()).toBe(1);
      denyCard('apr-1');
      expect(getPendingCount()).toBe(0);
    });

    it('returns null for nonexistent', () => {
      expect(denyCard('nonexistent')).toBeNull();
    });
  });

  describe('getPendingCards', () => {
    it('returns empty when no approvals', () => {
      expect(getPendingCards()).toHaveLength(0);
    });

    it('returns only pending cards', () => {
      createApprovalCard('apr-1', 'a', BRAIN_DID, 'general', '', '');
      createApprovalCard('apr-2', 'b', BRAIN_DID, 'general', '', '');
      approveCard('apr-1', 'single', USER_DID);

      const pending = getPendingCards();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('apr-2');
    });
  });

  describe('isApproved + consumeApproval', () => {
    it('isApproved returns true after approval', () => {
      createApprovalCard('apr-1', 'a', BRAIN_DID, 'general', '', '');
      approveCard('apr-1', 'single', USER_DID);

      expect(isApproved('apr-1')).toBe(true);
    });

    it('consumeApproval removes single-use grant', () => {
      createApprovalCard('apr-1', 'a', BRAIN_DID, 'general', '', '');
      approveCard('apr-1', 'single', USER_DID);

      expect(consumeApproval('apr-1')).toBe(true);
      expect(isApproved('apr-1')).toBe(false);
    });

    it('session-scoped grants survive consumption', () => {
      createApprovalCard('apr-1', 'a', BRAIN_DID, 'general', '', '');
      approveCard('apr-1', 'session', USER_DID);

      expect(consumeApproval('apr-1')).toBe(false); // session grants don't consume
      expect(isApproved('apr-1')).toBe(true); // still valid
    });
  });

  describe('endSession', () => {
    it('revokes all session-scoped approvals', () => {
      createApprovalCard('apr-1', 'a', BRAIN_DID, 'general', '', '');
      createApprovalCard('apr-2', 'b', BRAIN_DID, 'general', '', '');
      approveCard('apr-1', 'session', USER_DID);
      approveCard('apr-2', 'session', USER_DID);

      const revoked = endSession();
      expect(revoked).toBe(2);
      expect(isApproved('apr-1')).toBe(false);
      expect(isApproved('apr-2')).toBe(false);
    });

    it('does not revoke single-use grants (already consumed or still valid)', () => {
      createApprovalCard('apr-1', 'a', BRAIN_DID, 'general', '', '');
      approveCard('apr-1', 'single', USER_DID);

      const revoked = endSession();
      expect(revoked).toBe(0);
    });
  });

  describe('getCard', () => {
    it('returns card data by ID', () => {
      createApprovalCard('apr-1', 'test', BRAIN_DID, 'general', 'reason', 'preview');
      const card = getCard('apr-1');

      expect(card).not.toBeNull();
      expect(card!.action).toBe('test');
      expect(card!.reason).toBe('reason');
    });

    it('returns null for missing ID', () => {
      expect(getCard('nonexistent')).toBeNull();
    });
  });
});
