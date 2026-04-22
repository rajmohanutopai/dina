/**
 * T7.7 — Connector settings: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 7.7
 */

import {
  registerConnector,
  connectConnector,
  disconnectConnector,
  triggerSync,
  setSyncMode,
  reportError,
  getConnectorList,
  getConnector,
  getConnectorCounts,
  getAvailableTypes,
  resetConnectors,
} from '../../src/hooks/useConnectorSettings';

describe('Connector Settings Hook (7.7)', () => {
  beforeEach(() => resetConnectors());

  describe('registerConnector', () => {
    it('registers a new connector', () => {
      const c = registerConnector('gmail-1', 'gmail', 'Gmail');

      expect(c.id).toBe('gmail-1');
      expect(c.type).toBe('gmail');
      expect(c.status).toBe('disconnected');
      expect(c.syncMode).toBe('manual');
      expect(c.lastSyncLabel).toBe('Never synced');
    });

    it('supports custom description and account', () => {
      registerConnector('cal-1', 'calendar', 'Calendar', {
        description: 'Google Calendar sync',
        accountLabel: 'user@gmail.com',
      });

      const c = getConnector('cal-1');
      expect(c!.description).toBe('Google Calendar sync');
      expect(c!.accountLabel).toBe('user@gmail.com');
    });
  });

  describe('connectConnector', () => {
    it('connects and sets account label', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      expect(connectConnector('gmail-1', 'alice@gmail.com')).toBeNull();

      const c = getConnector('gmail-1');
      expect(c!.status).toBe('connected');
      expect(c!.accountLabel).toBe('alice@gmail.com');
    });

    it('clears previous error on connect', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      reportError('gmail-1', 'OAuth failed');
      connectConnector('gmail-1', 'alice@gmail.com');

      expect(getConnector('gmail-1')!.error).toBeNull();
    });

    it('returns error for unknown connector', () => {
      expect(connectConnector('nonexistent', 'x')).not.toBeNull();
    });
  });

  describe('disconnectConnector', () => {
    it('disconnects and clears account', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      connectConnector('gmail-1', 'alice@gmail.com');
      disconnectConnector('gmail-1');

      const c = getConnector('gmail-1');
      expect(c!.status).toBe('disconnected');
      expect(c!.accountLabel).toBe('');
    });

    it('resets sync mode to manual', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      connectConnector('gmail-1', 'alice@gmail.com');
      setSyncMode('gmail-1', 'auto');
      disconnectConnector('gmail-1');

      expect(getConnector('gmail-1')!.syncMode).toBe('manual');
    });
  });

  describe('triggerSync', () => {
    it('syncs and updates last sync time', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      connectConnector('gmail-1', 'alice@gmail.com');

      const before = Date.now();
      expect(triggerSync('gmail-1')).toBeNull();

      const c = getConnector('gmail-1');
      expect(c!.lastSyncAt).toBeGreaterThanOrEqual(before);
      expect(c!.lastSyncLabel).toBe('Just now');
      expect(c!.itemsSynced).toBeGreaterThan(0);
      expect(c!.status).toBe('connected');
    });

    it('rejects sync when disconnected', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      expect(triggerSync('gmail-1')).toContain('not connected');
    });

    it('rejects unknown connector', () => {
      expect(triggerSync('nonexistent')).not.toBeNull();
    });
  });

  describe('setSyncMode', () => {
    it('changes sync mode', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      setSyncMode('gmail-1', 'auto');
      expect(getConnector('gmail-1')!.syncMode).toBe('auto');
    });

    it('supports disabled mode', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      setSyncMode('gmail-1', 'disabled');
      expect(getConnector('gmail-1')!.syncMode).toBe('disabled');
    });
  });

  describe('reportError', () => {
    it('sets error state', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      reportError('gmail-1', 'Token expired');

      const c = getConnector('gmail-1');
      expect(c!.status).toBe('error');
      expect(c!.error).toBe('Token expired');
    });
  });

  describe('getConnectorList', () => {
    it('returns all connectors', () => {
      registerConnector('gmail-1', 'gmail', 'Gmail');
      registerConnector('cal-1', 'calendar', 'Calendar');

      expect(getConnectorList()).toHaveLength(2);
    });
  });

  describe('getConnectorCounts', () => {
    it('counts by status', () => {
      registerConnector('a', 'gmail', 'A');
      registerConnector('b', 'calendar', 'B');
      registerConnector('c', 'contacts', 'C');
      connectConnector('a', 'user@gmail.com');
      reportError('c', 'Failed');

      const counts = getConnectorCounts();
      expect(counts.total).toBe(3);
      expect(counts.connected).toBe(1);
      expect(counts.errors).toBe(1);
    });
  });

  describe('getAvailableTypes', () => {
    it('returns 3 connector types', () => {
      const types = getAvailableTypes();
      expect(types).toHaveLength(3);
      expect(types.map((t) => t.type)).toEqual(['gmail', 'calendar', 'contacts']);
    });
  });
});
