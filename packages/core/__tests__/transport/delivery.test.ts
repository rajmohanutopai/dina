/**
 * T2A.12 — D2D message delivery: MsgBox relay routing, dead drop drain,
 * DID resolution caching.
 *
 * Category B: contract test.
 *
 * Source: core/test/transport_test.go
 */

import {
  deliverMessage,
  msgboxWSToForwardURL,
  drainDeadDrop,
  resolveMessagingEndpoint,
  invalidateDIDCache,
  clearDIDCache,
  cacheDIDResolution,
  lookupDIDCache,
  setDeliveryFetchFn,
  setDIDResolver,
  setSpoolDrainHandler,
  resetDeliveryDeps,
} from '../../src/transport/delivery';

describe('D2D Message Delivery', () => {
  beforeEach(() => {
    clearDIDCache();
    resetDeliveryDeps();
  });

  describe('deliverMessage', () => {
    it('delivers via MsgBox relay for DinaMsgBox type', async () => {
      setDeliveryFetchFn(async (url: any) => {
        expect(String(url)).toContain('/forward');
        return {
          ok: true,
          json: async () => ({ status: 'delivered', msg_id: 'msg-1' }),
        } as Response;
      });
      const result = await deliverMessage(
        'did:plc:recipient',
        new Uint8Array([0xca, 0xfe]),
        'DinaMsgBox',
        'wss://mailbox.dinakernel.com',
      );
      expect(result.delivered).toBe(true);
      expect(result.messageId).toBe('msg-1');
    });

    it('delivers directly for DinaDirectHTTPS type', async () => {
      setDeliveryFetchFn(async (url: any) => {
        expect(String(url)).toContain('/msg');
        return { ok: true, text: async () => '{}' } as Response;
      });
      const result = await deliverMessage(
        'did:plc:recipient',
        new Uint8Array([0xca, 0xfe]),
        'DinaDirectHTTPS',
        'https://dina.example.com',
      );
      expect(result.delivered).toBe(true);
    });

    it('returns delivered:true on MsgBox success', async () => {
      setDeliveryFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'delivered', msg_id: 'x' }),
          }) as Response,
      );
      const result = await deliverMessage(
        'did:plc:r',
        new Uint8Array(0),
        'DinaMsgBox',
        'wss://mb.com',
      );
      expect(result.delivered).toBe(true);
      expect(result.buffered).toBe(false);
    });

    it('returns buffered:true when recipient offline (MsgBox)', async () => {
      setDeliveryFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'buffered', msg_id: 'buf-1' }),
          }) as Response,
      );
      const result = await deliverMessage(
        'did:plc:offline',
        new Uint8Array(0),
        'DinaMsgBox',
        'wss://mb.com',
      );
      expect(result.delivered).toBe(false);
      expect(result.buffered).toBe(true);
    });

    it('returns error on delivery failure', async () => {
      setDeliveryFetchFn(
        async () =>
          ({
            ok: false,
            status: 502,
            json: async () => ({}),
          }) as Response,
      );
      const result = await deliverMessage(
        'did:plc:fail',
        new Uint8Array(0),
        'DinaDirectHTTPS',
        'https://down.com',
      );
      expect(result.delivered).toBe(false);
      expect(result.error).toContain('502');
    });

    it('catches network errors gracefully', async () => {
      setDeliveryFetchFn(async () => {
        throw new Error('ECONNREFUSED');
      });
      const result = await deliverMessage(
        'did:plc:r',
        new Uint8Array(0),
        'DinaMsgBox',
        'wss://unreachable.com',
      );
      expect(result.delivered).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });
  });

  describe('msgboxWSToForwardURL', () => {
    it('wss:// → https:///forward', () => {
      expect(msgboxWSToForwardURL('wss://mailbox.dinakernel.com')).toBe(
        'https://mailbox.dinakernel.com/forward',
      );
    });

    it('ws:// → http:///forward', () => {
      expect(msgboxWSToForwardURL('ws://msgbox:7700')).toBe('http://msgbox:7700/forward');
    });

    it('strips trailing /ws', () => {
      expect(msgboxWSToForwardURL('wss://mailbox.dinakernel.com/ws')).toBe(
        'https://mailbox.dinakernel.com/forward',
      );
    });

    it('strips trailing slash', () => {
      expect(msgboxWSToForwardURL('wss://mailbox.dinakernel.com/')).toBe(
        'https://mailbox.dinakernel.com/forward',
      );
    });

    it('handles already-HTTP URL gracefully', () => {
      expect(msgboxWSToForwardURL('https://mailbox.dinakernel.com')).toBe(
        'https://mailbox.dinakernel.com/forward',
      );
    });

    it('handles URL with port', () => {
      expect(msgboxWSToForwardURL('wss://relay.example.com:8443')).toBe(
        'https://relay.example.com:8443/forward',
      );
    });

    it('handles ws://localhost', () => {
      expect(msgboxWSToForwardURL('ws://localhost:7700/ws')).toBe('http://localhost:7700/forward');
    });
  });

  describe('DID resolution cache', () => {
    it('caches and retrieves resolution', () => {
      cacheDIDResolution('did:plc:test', 'DinaMsgBox', 'wss://mb.com');
      expect(lookupDIDCache('did:plc:test')).toEqual({
        type: 'DinaMsgBox',
        endpoint: 'wss://mb.com',
      });
    });

    it('returns null for uncached DID', () => {
      expect(lookupDIDCache('did:plc:unknown')).toBeNull();
    });

    it('expires after 10-minute TTL', () => {
      cacheDIDResolution('did:plc:test', 'DinaMsgBox', 'wss://mb.com');
      expect(lookupDIDCache('did:plc:test', Date.now() + 11 * 60 * 1000)).toBeNull();
    });

    it('is valid within TTL', () => {
      cacheDIDResolution('did:plc:test', 'DinaMsgBox', 'wss://mb.com');
      expect(lookupDIDCache('did:plc:test', Date.now() + 9 * 60 * 1000)).not.toBeNull();
    });

    it('invalidateDIDCache removes specific entry', () => {
      cacheDIDResolution('did:plc:a', 'DinaMsgBox', 'wss://a.com');
      cacheDIDResolution('did:plc:b', 'DinaDirectHTTPS', 'https://b.com');
      invalidateDIDCache('did:plc:a');
      expect(lookupDIDCache('did:plc:a')).toBeNull();
      expect(lookupDIDCache('did:plc:b')).not.toBeNull();
    });

    it('invalidate is safe for non-cached DID', () => {
      invalidateDIDCache('did:plc:nonexistent');
    });

    it('clearDIDCache removes all entries', () => {
      cacheDIDResolution('did:plc:a', 'DinaMsgBox', 'wss://a.com');
      cacheDIDResolution('did:plc:b', 'DinaMsgBox', 'wss://b.com');
      clearDIDCache();
      expect(lookupDIDCache('did:plc:a')).toBeNull();
      expect(lookupDIDCache('did:plc:b')).toBeNull();
    });
  });

  describe('drainDeadDrop', () => {
    it('returns 0 when no handler registered', async () => {
      expect(await drainDeadDrop()).toBe(0);
    });

    it('calls spool drain handler and returns count', async () => {
      setSpoolDrainHandler(async () => 5);
      expect(await drainDeadDrop()).toBe(5);
    });

    it('returns 0 from handler when spool is empty', async () => {
      setSpoolDrainHandler(async () => 0);
      expect(await drainDeadDrop()).toBe(0);
    });
  });

  describe('resolveMessagingEndpoint', () => {
    it('returns cached resolution on cache hit', async () => {
      cacheDIDResolution('did:plc:cached', 'DinaMsgBox', 'wss://cached.com');
      const result = await resolveMessagingEndpoint('did:plc:cached');
      expect(result).toEqual({ type: 'DinaMsgBox', endpoint: 'wss://cached.com' });
    });

    it('calls resolver on cache miss', async () => {
      setDIDResolver(async (did) => {
        if (did === 'did:plc:test123') return { type: 'DinaMsgBox', endpoint: 'wss://test.com' };
        return null;
      });
      const result = await resolveMessagingEndpoint('did:plc:test123');
      expect(result).toEqual({ type: 'DinaMsgBox', endpoint: 'wss://test.com' });
    });

    it('caches resolved result', async () => {
      let callCount = 0;
      setDIDResolver(async () => {
        callCount++;
        return { type: 'DinaMsgBox' as const, endpoint: 'wss://x.com' };
      });
      await resolveMessagingEndpoint('did:plc:x');
      await resolveMessagingEndpoint('did:plc:x');
      expect(callCount).toBe(1); // second call uses cache
    });

    it('returns null for DID with no messaging service', async () => {
      setDIDResolver(async () => null);
      expect(await resolveMessagingEndpoint('did:plc:no-messaging')).toBeNull();
    });

    it('returns null when no resolver registered', async () => {
      expect(await resolveMessagingEndpoint('did:plc:test')).toBeNull();
    });
  });
});
