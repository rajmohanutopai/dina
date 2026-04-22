/**
 * T2A.14 — WebSocket message framing for paired device communication.
 *
 * Category B: contract test.
 *
 * Source: core/test/ws_test.go
 */

import {
  parseWSMessage,
  serializeWSMessage,
  isValidMessageType,
  buildAuthResponse,
  buildPing,
} from '../../src/ws/framing';
import type { WSMessage, WSMessageType } from '../../src/ws/framing';

describe('WebSocket Message Framing', () => {
  describe('parseWSMessage', () => {
    it('parses valid JSON message', () => {
      const msg = parseWSMessage('{"type":"query","timestamp":1700000000}');
      expect(msg.type).toBe('query');
      expect(msg.timestamp).toBe(1700000000);
    });

    it('rejects invalid JSON', () => {
      expect(() => parseWSMessage('not-json')).toThrow('invalid JSON');
    });

    it('rejects message without type', () => {
      expect(() => parseWSMessage('{"payload":"test"}')).toThrow('missing or invalid type');
    });

    it('rejects message with invalid type', () => {
      expect(() => parseWSMessage('{"type":"bogus","timestamp":0}')).toThrow(
        'missing or invalid type',
      );
    });

    it('rejects array input', () => {
      expect(() => parseWSMessage('[1,2,3]')).toThrow('must be a JSON object');
    });

    it('parses message with reply_to', () => {
      const msg = parseWSMessage('{"type":"whisper","reply_to":"req-001","timestamp":0}');
      expect(msg.type).toBe('whisper');
      expect(msg.reply_to).toBe('req-001');
    });

    it('parses message with payload', () => {
      const msg = parseWSMessage('{"type":"query","payload":{"q":"search"},"timestamp":0}');
      expect(msg.payload).toEqual({ q: 'search' });
    });

    it('defaults timestamp to Date.now() when missing', () => {
      const before = Date.now();
      const msg = parseWSMessage('{"type":"ping"}');
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('serializeWSMessage', () => {
    it('serializes to JSON string', () => {
      const msg: WSMessage = { type: 'whisper', timestamp: 1700000000 };
      const json = serializeWSMessage(msg);
      const parsed = JSON.parse(json);
      expect(parsed.type).toBe('whisper');
      expect(parsed.timestamp).toBe(1700000000);
    });

    it('includes optional fields when present', () => {
      const msg: WSMessage = {
        type: 'whisper',
        payload: { text: 'hi' },
        reply_to: 'req-001',
        timestamp: 0,
      };
      const json = serializeWSMessage(msg);
      const parsed = JSON.parse(json);
      expect(parsed.payload).toEqual({ text: 'hi' });
      expect(parsed.reply_to).toBe('req-001');
    });

    it('omits optional fields when absent', () => {
      const msg: WSMessage = { type: 'ping', timestamp: 0 };
      const json = serializeWSMessage(msg);
      const parsed = JSON.parse(json);
      expect(parsed.payload).toBeUndefined();
      expect(parsed.reply_to).toBeUndefined();
    });

    it('round-trips through parse → serialize → parse', () => {
      const original: WSMessage = {
        type: 'command',
        payload: { action: 'lock' },
        reply_to: 'r-1',
        timestamp: 99,
      };
      const serialized = serializeWSMessage(original);
      const reparsed = parseWSMessage(serialized);
      expect(reparsed.type).toBe(original.type);
      expect(reparsed.payload).toEqual(original.payload);
      expect(reparsed.reply_to).toBe(original.reply_to);
      expect(reparsed.timestamp).toBe(original.timestamp);
    });
  });

  describe('isValidMessageType', () => {
    const validTypes: WSMessageType[] = [
      'query',
      'command',
      'ack',
      'pong',
      'whisper',
      'whisper_stream',
      'system',
      'ping',
      'error',
      'auth_ok',
      'auth_fail',
    ];

    for (const type of validTypes) {
      it(`accepts "${type}"`, () => {
        expect(isValidMessageType(type)).toBe(true);
      });
    }

    it('rejects unknown type', () => {
      expect(isValidMessageType('invalid_type')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidMessageType('')).toBe(false);
    });
  });

  describe('buildAuthResponse', () => {
    it('builds auth_ok on success', () => {
      const msg = buildAuthResponse(true, 'iPhone 15');
      expect(msg.type).toBe('auth_ok');
      expect(msg.payload).toEqual({ device: 'iPhone 15' });
    });

    it('builds auth_fail on failure', () => {
      const msg = buildAuthResponse(false);
      expect(msg.type).toBe('auth_fail');
      expect(msg.payload).toBeUndefined();
    });

    it('includes device name on success', () => {
      const msg = buildAuthResponse(true, 'Pixel 8');
      expect(msg.type).toBe('auth_ok');
      expect((msg.payload as Record<string, string>).device).toBe('Pixel 8');
    });

    it('auth_ok without device name has no payload', () => {
      const msg = buildAuthResponse(true);
      expect(msg.type).toBe('auth_ok');
      expect(msg.payload).toBeUndefined();
    });

    it('has valid timestamp', () => {
      const before = Date.now();
      const msg = buildAuthResponse(true, 'device');
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('buildPing', () => {
    it('builds a ping message', () => {
      const msg = buildPing();
      expect(msg).toBeDefined();
      expect(msg.type).toBe('ping');
    });

    it('has type "ping"', () => {
      expect(buildPing().type).toBe('ping');
    });

    it('has current timestamp', () => {
      const before = Date.now();
      const msg = buildPing();
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('has no payload', () => {
      expect(buildPing().payload).toBeUndefined();
    });
  });
});
