/**
 * UCP on the phone (UCP plan §3.5, §3.11, §3.16): `startUcp` runs the profile
 * upload, merchant search and the guard worker only when UCP is on and the
 * node has a did:plc; `stopUcp` ends all three and waits for the worker; a
 * restart keeps one guard-call limit for the process.
 */

const publications: { stop: jest.Mock }[] = [];
const runtimes: unknown[] = [];

jest.mock('@dina/core', () => {
  const actual = jest.requireActual('@dina/core');
  return {
    ...actual,
    startPublisherSchedule: jest.fn(() => {
      const schedule = { stop: jest.fn() };
      publications.push(schedule);
      return schedule;
    }),
    installUcpSearchRuntime: jest.fn((runtime: unknown) => {
      runtimes.push(runtime);
      actual.installUcpSearchRuntime(runtime);
    }),
  };
});

// A stand-in identity database: nothing here reads rows, and installing the
// release log purges (a write that finds nothing).
const quietDb = {
  run: () => 0,
  query: () => [],
  execute: () => undefined,
  transaction: (fn: () => void) => fn(),
};
jest.mock('../../src/storage/init', () => ({ getIdentityAdapter: () => quietDb }));

jest.mock('../../src/hooks/useNodeBootstrap', () => ({ getBootedNode: () => null }));
jest.mock('../../src/ai/agentic_swap', () => ({ peekAgenticRouter: () => null }));

import { GuardSlots, UcpGuardWorker } from '@dina/brain';
import { A2AReleaseLog, installA2AReleaseLog } from '@dina/core';

import { startUcp, stopUcp } from '../../src/services/net_socket_wiring';
import { cachedUcpSearch, rememberUcpSearch } from '../../src/services/ucp_card_cache';

import type { DatabaseAdapter } from '@dina/core';

const PLC = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const started: UcpGuardWorker[] = [];
let stopOrder: string[] = [];

beforeEach(() => {
  publications.length = 0;
  runtimes.length = 0;
  started.length = 0;
  stopOrder = [];
  installA2AReleaseLog(new A2AReleaseLog(quietDb as unknown as DatabaseAdapter));
  jest.spyOn(UcpGuardWorker.prototype, 'start').mockImplementation(function (this: UcpGuardWorker) {
    started.push(this);
  });
  jest.spyOn(UcpGuardWorker.prototype, 'stop').mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 20));
    stopOrder.push('worker stopped');
  });
  process.env.EXPO_PUBLIC_DINA_UCP_ENABLED = '1';
});

afterEach(async () => {
  await stopUcp();
  installA2AReleaseLog(null);
  delete process.env.EXPO_PUBLIC_DINA_UCP_ENABLED;
  jest.restoreAllMocks();
});

const slotsOf = (w: UcpGuardWorker): unknown =>
  (w as unknown as { opts: { slots: unknown } }).opts.slots;

it('off unless UCP is enabled and the node has a did:plc', async () => {
  delete process.env.EXPO_PUBLIC_DINA_UCP_ENABLED;
  expect(await startUcp(PLC)).toBe(false);
  process.env.EXPO_PUBLIC_DINA_UCP_ENABLED = '1';
  expect(await startUcp('did:key:z6Mkexample')).toBe(false);
  expect(publications).toEqual([]);
  expect(started).toEqual([]);
  expect(runtimes.every((r) => r === null)).toBe(true);
});

it('on: the upload, search and the guard worker; stop ends all three and waits for the worker', async () => {
  expect(await startUcp(PLC)).toBe(true);
  expect(publications).toHaveLength(1);
  expect(runtimes.at(-1)).not.toBeNull();
  expect(started).toHaveLength(1);
  expect(slotsOf(started[0] as UcpGuardWorker)).toBeInstanceOf(GuardSlots);

  const stopping = stopUcp().then(() => stopOrder.push('stopUcp resolved'));
  await stopping;
  expect(publications[0]?.stop).toHaveBeenCalled();
  expect(runtimes.at(-1)).toBeNull();
  expect(stopOrder).toEqual(['worker stopped', 'stopUcp resolved']);
});

it('a restart stops the old worker first and keeps one guard-call limit for the process', async () => {
  await startUcp(PLC);
  await startUcp(PLC);
  expect(started).toHaveLength(2);
  expect(stopOrder).toEqual(['worker stopped']);
  expect(publications[0]?.stop).toHaveBeenCalled();
  expect(slotsOf(started[1] as UcpGuardWorker)).toBe(slotsOf(started[0] as UcpGuardWorker));
});

it('stopping UCP (seal, sign-out, erase) clears the cards’ memory of searches', async () => {
  rememberUcpSearch(
    'ucp-search-1',
    { search_id: 'ucp-search-1', created_at: 1, merchants: [], products: [] },
    null,
  );
  expect(cachedUcpSearch('ucp-search-1')).not.toBeNull();
  await stopUcp();
  expect(cachedUcpSearch('ucp-search-1')).toBeNull();
});
