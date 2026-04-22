/**
 * SSRF protection — blocks delivery to private/reserved IP addresses.
 *
 * Source: Gap Analysis A21 #9
 */

import {
  isDiscoverableURL,
  isPrivateIP,
  isBlockedHostname,
  extractHostname,
} from '../../src/transport/ssrf';

describe('SSRF Protection', () => {
  describe('isPrivateIP', () => {
    describe('IPv4 private ranges', () => {
      it('10.0.0.0/8 → private', () => {
        expect(isPrivateIP('10.0.0.1')).toBe(true);
        expect(isPrivateIP('10.255.255.255')).toBe(true);
      });

      it('172.16.0.0/12 → private', () => {
        expect(isPrivateIP('172.16.0.1')).toBe(true);
        expect(isPrivateIP('172.31.255.255')).toBe(true);
      });

      it('172.15.x and 172.32.x → public', () => {
        expect(isPrivateIP('172.15.0.1')).toBe(false);
        expect(isPrivateIP('172.32.0.1')).toBe(false);
      });

      it('192.168.0.0/16 → private', () => {
        expect(isPrivateIP('192.168.0.1')).toBe(true);
        expect(isPrivateIP('192.168.255.255')).toBe(true);
      });

      it('127.0.0.0/8 (loopback) → private', () => {
        expect(isPrivateIP('127.0.0.1')).toBe(true);
        expect(isPrivateIP('127.255.255.255')).toBe(true);
      });

      it('169.254.0.0/16 (link-local) → private', () => {
        expect(isPrivateIP('169.254.0.1')).toBe(true);
        expect(isPrivateIP('169.254.169.254')).toBe(true);
      });

      it('0.0.0.0/8 → private', () => {
        expect(isPrivateIP('0.0.0.0')).toBe(true);
      });

      it('100.64.0.0/10 (CGNAT) → private', () => {
        expect(isPrivateIP('100.64.0.1')).toBe(true);
        expect(isPrivateIP('100.127.255.255')).toBe(true);
      });

      it('100.128.0.1 → public (past CGNAT range)', () => {
        expect(isPrivateIP('100.128.0.1')).toBe(false);
      });
    });

    describe('IPv4 public addresses', () => {
      it('8.8.8.8 → public', () => {
        expect(isPrivateIP('8.8.8.8')).toBe(false);
      });

      it('1.1.1.1 → public', () => {
        expect(isPrivateIP('1.1.1.1')).toBe(false);
      });

      it('93.184.216.34 → public', () => {
        expect(isPrivateIP('93.184.216.34')).toBe(false);
      });
    });

    describe('IPv6', () => {
      it('::1 (loopback) → private', () => {
        expect(isPrivateIP('::1')).toBe(true);
      });

      it(':: (unspecified) → private', () => {
        expect(isPrivateIP('::')).toBe(true);
      });

      it('fc00:: / fd00:: (ULA) → private', () => {
        expect(isPrivateIP('fc00::1')).toBe(true);
        expect(isPrivateIP('fd12::abcd')).toBe(true);
      });

      it('fe80:: (link-local) → private', () => {
        expect(isPrivateIP('fe80::1')).toBe(true);
      });

      it('2001:db8:: → public (not in blocked list)', () => {
        expect(isPrivateIP('2001:db8::1')).toBe(false);
      });
    });
  });

  describe('isBlockedHostname', () => {
    it('localhost → blocked', () => {
      expect(isBlockedHostname('localhost')).toBe(true);
    });

    it('*.local → blocked', () => {
      expect(isBlockedHostname('server.local')).toBe(true);
      expect(isBlockedHostname('mynode.local')).toBe(true);
    });

    it('*.internal → blocked', () => {
      expect(isBlockedHostname('api.internal')).toBe(true);
    });

    it('public hostnames → not blocked', () => {
      expect(isBlockedHostname('example.com')).toBe(false);
      expect(isBlockedHostname('api.dina.dev')).toBe(false);
    });
  });

  describe('extractHostname', () => {
    it('extracts from https URL', () => {
      expect(extractHostname('https://api.example.com/forward')).toBe('api.example.com');
    });

    it('extracts from http URL', () => {
      expect(extractHostname('http://10.0.0.1:8080/msg')).toBe('10.0.0.1');
    });

    it('handles bare host:port', () => {
      expect(extractHostname('192.168.1.1:3000')).toBe('192.168.1.1');
    });

    it('returns null for invalid URL', () => {
      expect(extractHostname('')).toBe('');
    });
  });

  describe('isDiscoverableURL', () => {
    it('public URLs → true', () => {
      expect(isDiscoverableURL('https://relay.dina.dev/forward')).toBe(true);
      expect(isDiscoverableURL('https://93.184.216.34:443/msg')).toBe(true);
    });

    it('private IPs → false', () => {
      expect(isDiscoverableURL('https://10.0.0.1/forward')).toBe(false);
      expect(isDiscoverableURL('https://192.168.1.1:8080/msg')).toBe(false);
      expect(isDiscoverableURL('http://127.0.0.1:3000/msg')).toBe(false);
    });

    it('localhost → false', () => {
      expect(isDiscoverableURL('http://localhost:8080/api')).toBe(false);
    });

    it('.local domains → false', () => {
      expect(isDiscoverableURL('https://mynode.local/forward')).toBe(false);
    });

    it('link-local → false', () => {
      expect(isDiscoverableURL('http://169.254.169.254/latest/meta-data/')).toBe(false);
    });
  });
});
