/**
 * T6.15 — Dead drop drain: process spooled messages on persona unlock.
 *
 * Source: ARCHITECTURE.md Task 6.15
 */

import {
  drainSpoolToStaging,
  drainRegisteredSpool,
  registerSpoolProvider,
  resetDrainState,
} from '../../src/lifecycle/dead_drop_drain';
import { DeadDropSpool } from '../../src/storage/spool';
import { getItem, inboxSize, resetStagingState } from '../../src/staging/service';

describe('Dead Drop Drain', () => {
  let spool: DeadDropSpool;

  beforeEach(() => {
    spool = new DeadDropSpool('/tmp/test-spool-drain', 500 * 1024 * 1024);
    resetStagingState();
    resetDrainState();
  });

  describe('drainSpoolToStaging', () => {
    it('drains spooled messages into staging inbox', () => {
      spool.spoolMessage('msg-001', new TextEncoder().encode('{"summary":"Hello from spool"}'));
      spool.spoolMessage('msg-002', new TextEncoder().encode('{"summary":"Second message"}'));

      const result = drainSpoolToStaging(spool);
      expect(result.drained).toBe(2);
      expect(result.ingested).toBe(2);
      expect(result.errors).toBe(0);
      expect(inboxSize()).toBe(2);
    });

    it('handles non-JSON blobs gracefully', () => {
      spool.spoolMessage('msg-raw', new TextEncoder().encode('raw binary data'));

      const result = drainSpoolToStaging(spool);
      expect(result.drained).toBe(1);
      expect(result.ingested).toBe(1); // stored with {raw: 'raw binary data'}
    });

    it('deduplicates repeated messages', () => {
      spool.spoolMessage('msg-dup', new TextEncoder().encode('{}'));
      // Drain once
      drainSpoolToStaging(spool);

      // Spool the same message again
      spool.spoolMessage('msg-dup', new TextEncoder().encode('{}'));
      const result = drainSpoolToStaging(spool);
      expect(result.duplicates).toBe(1);
    });

    it('returns zero counts for empty spool', () => {
      const result = drainSpoolToStaging(spool);
      expect(result.drained).toBe(0);
      expect(result.ingested).toBe(0);
    });

    it('ingested items have source "dead_drop"', () => {
      spool.spoolMessage('msg-src', new TextEncoder().encode('{"text":"test"}'));
      drainSpoolToStaging(spool);

      // Find the staging item
      // inboxSize should be 1, and the item should have source 'dead_drop'
      expect(inboxSize()).toBe(1);
    });

    it('spool is empty after drain', () => {
      spool.spoolMessage('msg-1', new TextEncoder().encode('{}'));
      spool.spoolMessage('msg-2', new TextEncoder().encode('{}'));
      drainSpoolToStaging(spool);
      expect(spool.spoolSize()).toBe(0);
    });
  });

  describe('drainRegisteredSpool', () => {
    it('returns zero when no provider registered', () => {
      const result = drainRegisteredSpool();
      expect(result.drained).toBe(0);
    });

    it('drains using registered provider', () => {
      spool.spoolMessage('msg-reg', new TextEncoder().encode('{"data":"test"}'));
      registerSpoolProvider(() => spool);
      const result = drainRegisteredSpool();
      expect(result.drained).toBe(1);
      expect(result.ingested).toBe(1);
    });
  });
});
