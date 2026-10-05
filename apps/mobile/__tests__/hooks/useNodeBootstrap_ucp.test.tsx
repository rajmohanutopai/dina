/**
 * UCP and the node's life on the phone (UCP plan §3.5, §3.11): UCP starts
 * only once the node is up, never for a boot that fails, is stopped again
 * when the hook was dropped while it started, and stops before the node is
 * disposed (its search and guard read the node's Core and database).
 */

import { act, renderHook } from '@testing-library/react-native';

const order: string[] = [];
let failBoot = false;
let startGate: Promise<void> = Promise.resolve();

jest.mock('../../src/services/boot_capabilities', () => ({
  buildBootInputs: jest.fn(async () => ({ did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' })),
}));

jest.mock('../../src/services/boot_service', () => {
  class BootStartupError extends Error {
    degradations = [];
  }
  return {
    BootStartupError,
    bootAppNode: jest.fn(async () => {
      if (failBoot) throw new Error('boot failed');
      order.push('node up');
      return {
        node: {
          dispose: jest.fn(async () => {
            order.push('node disposed');
          }),
        },
        degradations: [],
      };
    }),
  };
});

jest.mock('../../src/services/net_socket_wiring', () => ({
  startUcp: jest.fn(async (did: string) => {
    await startGate;
    order.push(`ucp started ${did}`);
    return true;
  }),
  stopUcp: jest.fn(async () => {
    order.push('ucp stopped');
  }),
}));

import { useNodeBootstrap } from '../../src/hooks/useNodeBootstrap';

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  order.length = 0;
  failBoot = false;
  startGate = Promise.resolve();
});

it('UCP starts after the node is up, and stops before the node is disposed', async () => {
  const hook = renderHook(() => useNodeBootstrap());
  await settle();
  expect(hook.result.current.status).toBe('ready');
  expect(order).toEqual(['node up', 'ucp started did:plc:aaaaaaaaaaaaaaaaaaaaaaaa']);
  hook.unmount();
  await settle();
  expect(order.slice(2)).toEqual(['ucp stopped', 'node disposed']);
});

it('a boot that fails starts no UCP', async () => {
  failBoot = true;
  const hook = renderHook(() => useNodeBootstrap());
  await settle();
  expect(hook.result.current.status).toBe('error');
  expect(order).toEqual([]);
  hook.unmount();
});

it('a hook dropped while UCP was starting stops it again', async () => {
  let open: () => void = () => undefined;
  startGate = new Promise((r) => {
    open = r;
  });
  const hook = renderHook(() => useNodeBootstrap());
  await settle();
  hook.unmount();
  open();
  await settle();
  expect(order).toContain('ucp started did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
  expect(order.at(-1)).toBe('ucp stopped');
  // The teardown stops UCP before disposing the node; the start that lands later is stopped again.
  expect(order.lastIndexOf('ucp stopped')).toBeGreaterThan(
    order.indexOf('ucp started did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'),
  );
});
