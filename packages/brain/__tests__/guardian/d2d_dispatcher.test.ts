/**
 * BRAIN-P1-T — Guardian D2D dispatcher tests.
 *
 * Covers:
 *   - Handler registration + routing
 *   - Unknown message type → `{routed: false}` (not thrown)
 *   - Scanner can drop a message before dispatch
 *   - Scanner can transform the body before the handler sees it
 *   - Handler errors are isolated and reported via onError
 *   - Disposer unregisters correctly
 *   - Default module-level dispatcher is singleton and resettable
 */

import {
  D2DDispatcher,
  getDefaultDispatcher,
  resetDefaultDispatcher,
  type D2DScanner,
  type D2DHandler,
} from '../../src/guardian/d2d_dispatcher';
import type { DinaMessage } from '@dina/test-harness';

function makeMessage(type: string, body: Record<string, unknown>): DinaMessage {
  return {
    id: `msg-${type}-1`,
    type,
    from: 'did:plc:sender',
    to: 'did:plc:me',
    created_time: 1_700_000_000,
    body: JSON.stringify(body),
  };
}

describe('D2DDispatcher', () => {
  describe('register / isRegistered / registeredTypes', () => {
    it('registers a handler and reports it', () => {
      const d = new D2DDispatcher();
      const h: D2DHandler = () => {
        /* no-op */
      };
      d.register('service.query', h);
      expect(d.isRegistered('service.query')).toBe(true);
      expect(d.registeredTypes()).toEqual(['service.query']);
    });

    it('registeredTypes is sorted alphabetically', () => {
      const d = new D2DDispatcher();
      d.register('service.response', () => {
        /* */
      });
      d.register('service.query', () => {
        /* */
      });
      expect(d.registeredTypes()).toEqual(['service.query', 'service.response']);
    });

    it('overwrites on re-register', () => {
      const d = new D2DDispatcher();
      const a: D2DHandler = jest.fn();
      const b: D2DHandler = jest.fn();
      d.register('service.query', a);
      d.register('service.query', b);
      expect(d.registeredTypes()).toEqual(['service.query']);
      // Confirm `b` is the active one.
      return d.dispatch('did:plc:x', makeMessage('service.query', {}), {}).then(() => {
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
      });
    });

    it('throws on empty message type', () => {
      const d = new D2DDispatcher();
      expect(() =>
        d.register('', () => {
          /* */
        }),
      ).toThrow(/messageType/);
    });

    it('throws on non-function handler', () => {
      const d = new D2DDispatcher();
      expect(() => d.register('service.query', 'not a function' as unknown as D2DHandler)).toThrow(
        /function/,
      );
    });

    it('disposer unregisters the handler', () => {
      const d = new D2DDispatcher();
      const dispose = d.register('service.query', () => {
        /* */
      });
      expect(d.isRegistered('service.query')).toBe(true);
      dispose();
      expect(d.isRegistered('service.query')).toBe(false);
    });

    it('disposer is a no-op after another handler replaces the registration', async () => {
      const d = new D2DDispatcher();
      const originalDispose = d.register('service.query', () => {
        /* */
      });
      const newHandler: D2DHandler = jest.fn();
      d.register('service.query', newHandler); // overwrites
      originalDispose(); // should NOT remove the replacement

      expect(d.isRegistered('service.query')).toBe(true);
      await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(newHandler).toHaveBeenCalled();
    });
  });

  describe('dispatch — routing', () => {
    it('calls the registered handler with (fromDID, body, raw)', async () => {
      const d = new D2DDispatcher();
      const h: D2DHandler = jest.fn();
      d.register('service.query', h);

      const raw = makeMessage('service.query', { query_id: 'q1' });
      const body = { query_id: 'q1', capability: 'eta_query' };
      const res = await d.dispatch('did:plc:bus42', raw, body);

      expect(res.routed).toBe(true);
      expect(res.dropped).toBe(false);
      expect(h).toHaveBeenCalledWith('did:plc:bus42', body, raw);
    });

    it('awaits async handlers', async () => {
      const d = new D2DDispatcher();
      let completed = false;
      d.register('service.query', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        completed = true;
      });
      await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(completed).toBe(true);
    });

    it('unknown message type returns {routed: false} (does not throw)', async () => {
      const d = new D2DDispatcher();
      const res = await d.dispatch('did:plc:x', makeMessage('foo.unknown', {}), {});
      expect(res.routed).toBe(false);
      expect(res.dropped).toBe(false);
      expect(res.reason).toMatch(/no handler/);
    });
  });

  describe('scanner integration', () => {
    it('passes the scanned body (not raw) to the handler', async () => {
      const d = new D2DDispatcher();
      const received: Record<string, unknown>[] = [];
      d.register('service.query', (_from, body) => {
        received.push(body);
      });

      const scanner: D2DScanner = (_t, body) => ({
        body: { ...body, scrubbed: true },
      });
      d.setScanner(scanner);

      await d.dispatch('did:plc:x', makeMessage('service.query', {}), { name: 'raw' });
      expect(received).toEqual([{ name: 'raw', scrubbed: true }]);
    });

    it('scanner-dropped messages are not routed', async () => {
      const d = new D2DDispatcher();
      const handler: D2DHandler = jest.fn();
      d.register('service.query', handler);

      d.setScanner(() => ({ body: {}, dropped: true, reason: 'pii block' }));
      const res = await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});

      expect(res.routed).toBe(false);
      expect(res.dropped).toBe(true);
      expect(res.reason).toBe('pii block');
      expect(handler).not.toHaveBeenCalled();
    });

    it('drop with no reason falls back to default', async () => {
      const d = new D2DDispatcher();
      d.register('service.query', () => {
        /* */
      });
      d.setScanner(() => ({ body: {}, dropped: true }));
      const res = await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(res.dropped).toBe(true);
      expect(res.reason).toBe('dropped by scanner');
    });

    it('setScanner(null) clears the scanner', async () => {
      const d = new D2DDispatcher();
      d.register('service.query', () => {
        /* */
      });
      d.setScanner(() => ({ body: {}, dropped: true }));
      d.setScanner(null);
      const res = await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(res.routed).toBe(true);
    });
  });

  describe('error isolation', () => {
    it('catches synchronous handler errors', async () => {
      const d = new D2DDispatcher();
      d.register('service.query', () => {
        throw new Error('sync boom');
      });

      const res = await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(res.routed).toBe(true);
      expect(res.handlerError).toBeInstanceOf(Error);
      expect((res.handlerError as Error).message).toBe('sync boom');
    });

    it('catches async handler rejections', async () => {
      const d = new D2DDispatcher();
      d.register('service.query', async () => {
        throw new Error('async boom');
      });

      const res = await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(res.handlerError).toBeInstanceOf(Error);
      expect((res.handlerError as Error).message).toBe('async boom');
    });

    it('invokes onError observer with (err, messageType)', async () => {
      const d = new D2DDispatcher();
      const observed: Array<{ err: unknown; type: string }> = [];
      d.setErrorObserver((err, type) => observed.push({ err, type }));
      d.register('service.query', () => {
        throw new Error('X');
      });

      await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(observed).toHaveLength(1);
      expect(observed[0].type).toBe('service.query');
      expect((observed[0].err as Error).message).toBe('X');
    });

    it('one handler failure does NOT affect subsequent dispatches', async () => {
      const d = new D2DDispatcher();
      let secondCalled = false;
      d.register('service.query', () => {
        throw new Error('first');
      });
      d.register('service.response', () => {
        secondCalled = true;
      });

      await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      await d.dispatch('did:plc:x', makeMessage('service.response', {}), {});

      expect(secondCalled).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears handlers, scanner, and onError', async () => {
      const d = new D2DDispatcher();
      const observer = jest.fn();
      d.setErrorObserver(observer);
      d.setScanner(() => ({ body: {}, dropped: true }));
      d.register('service.query', () => {
        throw new Error('X');
      });

      d.reset();

      expect(d.isRegistered('service.query')).toBe(false);
      const res = await d.dispatch('did:plc:x', makeMessage('service.query', {}), {});
      expect(res.routed).toBe(false);
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe('default module-level instance', () => {
    beforeEach(() => resetDefaultDispatcher());
    afterAll(() => resetDefaultDispatcher());

    it('getDefaultDispatcher returns a stable singleton', () => {
      const a = getDefaultDispatcher();
      const b = getDefaultDispatcher();
      expect(a).toBe(b);
    });

    it('resetDefaultDispatcher produces a fresh instance on next call', () => {
      const a = getDefaultDispatcher();
      resetDefaultDispatcher();
      const b = getDefaultDispatcher();
      expect(a).not.toBe(b);
    });
  });
});
