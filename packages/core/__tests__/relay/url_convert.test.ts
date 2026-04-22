/**
 * T6.2 — MsgBox URL conversion: wss:// ↔ https:// forward.
 *
 * Matches server transport.go:462-471.
 *
 * Source: ARCHITECTURE.md Task 6.2
 */

import {
  msgboxWSToForwardURL,
  forwardURLToMsgboxWS,
  extractMsgboxHost,
} from '../../src/relay/url_convert';

describe('msgboxWSToForwardURL', () => {
  it('converts wss:// to https:// + /forward', () => {
    expect(msgboxWSToForwardURL('wss://mailbox.dinakernel.com/ws')).toBe(
      'https://mailbox.dinakernel.com/forward',
    );
  });

  it('converts ws:// to http:// + /forward', () => {
    expect(msgboxWSToForwardURL('ws://localhost:9090/ws')).toBe('http://localhost:9090/forward');
  });

  it('handles trailing slash on /ws/', () => {
    expect(msgboxWSToForwardURL('wss://relay.example.com/ws/')).toBe(
      'https://relay.example.com/forward',
    );
  });

  it('handles URL without /ws path', () => {
    expect(msgboxWSToForwardURL('wss://relay.example.com')).toBe(
      'https://relay.example.com/forward',
    );
  });

  it('handles URL with port', () => {
    expect(msgboxWSToForwardURL('wss://relay.example.com:8443/ws')).toBe(
      'https://relay.example.com:8443/forward',
    );
  });

  it('trims whitespace', () => {
    expect(msgboxWSToForwardURL('  wss://relay.example.com/ws  ')).toBe(
      'https://relay.example.com/forward',
    );
  });

  it('throws for empty URL', () => {
    expect(() => msgboxWSToForwardURL('')).toThrow('required');
  });

  it('throws for non-WebSocket URL', () => {
    expect(() => msgboxWSToForwardURL('https://example.com')).toThrow('expected wss:// or ws://');
  });

  it('handles complex path before /ws', () => {
    expect(msgboxWSToForwardURL('wss://relay.example.com/api/v1/ws')).toBe(
      'https://relay.example.com/api/v1/forward',
    );
  });
});

describe('forwardURLToMsgboxWS (inverse)', () => {
  it('converts https:// to wss:// + /ws', () => {
    expect(forwardURLToMsgboxWS('https://mailbox.dinakernel.com/forward')).toBe(
      'wss://mailbox.dinakernel.com/ws',
    );
  });

  it('converts http:// to ws:// + /ws', () => {
    expect(forwardURLToMsgboxWS('http://localhost:9090/forward')).toBe('ws://localhost:9090/ws');
  });

  it('handles trailing slash', () => {
    expect(forwardURLToMsgboxWS('https://relay.example.com/forward/')).toBe(
      'wss://relay.example.com/ws',
    );
  });

  it('throws for empty URL', () => {
    expect(() => forwardURLToMsgboxWS('')).toThrow('required');
  });

  it('throws for non-HTTP URL', () => {
    expect(() => forwardURLToMsgboxWS('wss://example.com')).toThrow('expected https:// or http://');
  });
});

describe('round-trip conversion', () => {
  const urls = [
    'wss://mailbox.dinakernel.com/ws',
    'ws://localhost:9090/ws',
    'wss://relay.example.com:8443/ws',
  ];

  for (const wsURL of urls) {
    it(`round-trips: ${wsURL}`, () => {
      const forward = msgboxWSToForwardURL(wsURL);
      const back = forwardURLToMsgboxWS(forward);
      expect(back).toBe(wsURL);
    });
  }
});

describe('extractMsgboxHost', () => {
  it('extracts host from wss URL', () => {
    expect(extractMsgboxHost('wss://mailbox.dinakernel.com/ws')).toBe('mailbox.dinakernel.com');
  });

  it('extracts host:port from ws URL', () => {
    expect(extractMsgboxHost('ws://localhost:9090/ws')).toBe('localhost:9090');
  });

  it('extracts host from https URL', () => {
    expect(extractMsgboxHost('https://relay.example.com/forward')).toBe('relay.example.com');
  });
});
