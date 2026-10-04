/**
 * The gateway's own key and configuration: it starts only with its own key,
 * checked against the DID Core registered, and with sane limits.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { deriveDIDKey, getPublicKey } from '@dina/core';

import { ConfigError, loadConfig } from '../src/config';
import { isClientAnswer } from '../src/core_link';
import { EdgeLimiter, clientKeyOf } from '../src/edge_limit';
import { ensureServiceKey } from '../src/keygen';
import { loadServiceKey } from '../src/service_key';
import { StreamHub, StreamSlots } from '../src/stream_hub';

let dir: string;
const seed = new Uint8Array(32).fill(9);
const did = deriveDIDKey(getPublicKey(seed));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-gw-key-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('service key', () => {
  it('loads a 32-byte seed and checks it against the registered DID', async () => {
    writeFileSync(path.join(dir, 'gateway.ed25519'), seed);
    expect(await loadServiceKey(dir, 'gateway.ed25519', did)).toEqual({ ok: true, key: { seed, did } });
    expect(await loadServiceKey(dir, 'gateway.ed25519', 'did:key:z6MkSomeoneElse')).toEqual({ ok: false, reason: 'did_mismatch' });
  });

  it('refuses a missing directory, a missing file, and a wrong size', async () => {
    expect(await loadServiceKey('', 'gateway.ed25519')).toEqual({ ok: false, reason: 'key_missing' });
    expect(await loadServiceKey(dir, 'gateway.ed25519')).toEqual({ ok: false, reason: 'key_missing' });
    writeFileSync(path.join(dir, 'short'), new Uint8Array(31));
    expect(await loadServiceKey(dir, 'short')).toEqual({ ok: false, reason: 'key_invalid' });
  });
});

describe('config', () => {
  it('defaults to loopback on 8400, Core on 8100, 120 calls per address per minute', () => {
    const c = loadConfig({ DINA_A2A_GATEWAY_KEY_DIR: dir });
    expect(c.network).toEqual({ host: '127.0.0.1', port: 8400, trustProxy: 0 });
    expect(c.core.baseUrl).toBe('http://127.0.0.1:8100');
    expect(c.limits.perIpPerMinute).toBe(120);
    expect(c.serviceKey.file).toBe('gateway.ed25519');
  });

  it.each([
    ['a path in the key file name', { DINA_A2A_GATEWAY_KEY_FILE: '../core/keyfile' }],
    ['a DID that is not a did:key', { DINA_A2A_GATEWAY_DID: 'did:plc:x' }],
    ['a port out of range', { DINA_A2A_GATEWAY_PORT: '70000' }],
    ['a zero edge limit', { DINA_A2A_GATEWAY_IP_LIMIT: '0' }],
  ])('refuses %s', (_name, extra) => {
    expect(() => loadConfig({ DINA_A2A_GATEWAY_KEY_DIR: dir, ...extra })).toThrow(ConfigError);
  });
});

describe('which Core answers reach the client', () => {
  it('only answers Core’s ingress handler marked as written for the client', () => {
    expect(isClientAnswer({ 'x-dina-a2a-answer': '1' })).toBe(true);
    // A Core-wide limit or a refusal of the gateway itself carries no mark.
    expect(isClientAnswer({ 'retry-after': '60' })).toBe(false);
    expect(isClientAnswer({ 'x-dina-a2a-answer': '0' })).toBe(false);
    expect(isClientAnswer({})).toBe(false);
  });
});

describe('edge limiter (design §4.1; dual review CL-2)', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff::9', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::ffff:c000:201', '192.0.2.1'],
    ['0:0:0:0:0:ffff:192.0.2.1', '192.0.2.1'],
    ['not an address', 'not an address'],
  ])('%s is the client %s', (address, client) => {
    expect(clientKeyOf(address)).toBe(client);
  });

  it('every address of one IPv6 /64 shares one limit; another /64 has its own; a mapped IPv4 address is its IPv4 client', () => {
    const limiter = new EdgeLimiter(2, () => 0);
    expect(limiter.allow('2001:db8:1:2::1')).toBe(true);
    expect(limiter.allow('2001:db8:1:2::2')).toBe(true);
    expect(limiter.allow('2001:db8:1:2:abcd::3')).toBe(false);
    expect(limiter.allow('2001:db8:1:3::1')).toBe(true);
    expect(limiter.allow('192.0.2.7')).toBe(true);
    expect(limiter.allow('::ffff:192.0.2.7')).toBe(true);
    expect(limiter.allow('::ffff:c000:207')).toBe(false);
  });

  it('a full table never shuts out a new client: the oldest window goes, and the table stays bounded', () => {
    let now = 0;
    const limiter = new EdgeLimiter(1, () => now, 100);
    // One client spends its minute first; then a spray of others fills the table.
    expect(limiter.allow('192.0.2.1')).toBe(true);
    expect(limiter.allow('192.0.2.1')).toBe(false);
    for (let i = 0; i < 99; i += 1) {
      now += 1;
      expect(limiter.allow(`2001:db8:${i.toString(16)}::1`)).toBe(true);
    }
    expect(limiter.size).toBe(100);
    // Another prefix arrives: it is let in, and the oldest window (192.0.2.1's) made room for it.
    now += 1;
    expect(limiter.allow('2001:db8:ffff::1')).toBe(true);
    expect(limiter.size).toBe(100);
    expect(limiter.allow('192.0.2.1')).toBe(true);
    expect(limiter.size).toBe(100);
  });

  it('windows that ended are dropped first, oldest first, before any live one goes', () => {
    let now = 0;
    const limiter = new EdgeLimiter(1, () => now, 3);
    limiter.allow('192.0.2.1');
    now = 10;
    limiter.allow('192.0.2.2');
    now = 20;
    limiter.allow('192.0.2.3');
    // 192.0.2.1's window has ended; the other two have not.
    now = 60_005;
    expect(limiter.allow('192.0.2.4')).toBe(true);
    expect(limiter.size).toBe(3);
    // The live ones were kept, their minutes still spent.
    expect(limiter.allow('192.0.2.2')).toBe(false);
    expect(limiter.allow('192.0.2.3')).toBe(false);
  });
});

describe('stream slots (dual review CL-2)', () => {
  it('are counted per client: the addresses of one IPv6 /64 share them', () => {
    const hub = new StreamHub({ maxStreams: 10, bufferMs: 1_000, bufferEvents: 4, bufferTasks: 4, bufferBytes: 1 << 20 });
    const slots = new StreamSlots(hub, 2);
    expect(slots.take('2001:db8:1:2::1')).toBe(true);
    expect(slots.take('2001:db8:1:2::2')).toBe(true);
    expect(slots.take('2001:db8:1:2::3')).toBe(false);
    expect(slots.take('2001:db8:1:3::1')).toBe(true);
    // A slot freed under one address of the /64 is the client's to take again.
    slots.release('2001:db8:1:2::2');
    expect(slots.take('2001:db8:1:2::9')).toBe(true);
  });
});

describe('keygen', () => {
  it('creates the key once, mode 0600, and prints the same DID on every run', async () => {
    const keyDir = path.join(dir, 'keys');
    const first = await ensureServiceKey(keyDir, 'gateway.ed25519');
    expect(first.created).toBe(true);
    expect(first.did.startsWith('did:key:z')).toBe(true);
    expect(statSync(path.join(keyDir, 'gateway.ed25519')).mode & 0o777).toBe(0o600);
    expect(await ensureServiceKey(keyDir, 'gateway.ed25519')).toEqual({ did: first.did, created: false });
  });

  it('refuses to replace a key file that is not a key', async () => {
    writeFileSync(path.join(dir, 'gateway.ed25519'), new Uint8Array(7));
    await expect(ensureServiceKey(dir, 'gateway.ed25519')).rejects.toThrow(/key_invalid/);
  });
});
