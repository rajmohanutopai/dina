/**
 * PH-05: lock during boot, then unlock. Only one node at a time may write
 * process globals, so the next boot waits for the dropped one to finish and
 * dispose.
 */

import { act, renderHook } from '@testing-library/react-native';

import { getBootedNode, useNodeBootstrap } from '../../src/hooks/useNodeBootstrap';

const order: string[] = [];
const gates: Array<() => void> = [];
let booted = 0;

jest.mock('../../src/services/boot_capabilities', () => ({
  buildBootInputs: jest.fn(async () => ({ did: 'did:plc:x' })),
}));
jest.mock('../../src/services/boot_service', () => {
  class BootStartupError extends Error {
    degradations = [];
  }
  return {
    BootStartupError,
    bootAppNode: jest.fn(async () => {
      booted += 1;
      const id = booted === 1 ? 'A' : 'B';
      order.push(`${id} boot started`);
      await new Promise<void>((resolve) => gates.push(resolve));
      order.push(`${id} boot finished`);
      return {
        node: {
          id,
          dispose: jest.fn(async () => {
            order.push(`${id} disposed`);
          }),
        },
        degradations: [],
      };
    }),
  };
});
jest.mock('../../src/services/net_socket_wiring', () => ({
  startUcp: jest.fn(async () => true),
  stopUcp: jest.fn(async () => undefined),
}));

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

it('the next boot starts only after the dropped boot has disposed its node', async () => {
  const hook = renderHook(({ on }: { on: boolean }) => useNodeBootstrap({ enabled: on }), {
    initialProps: { on: true },
  });
  await settle();
  hook.rerender({ on: false }); // seal during boot
  await settle();
  hook.rerender({ on: true }); // unlock while boot A still waits on the relay
  await settle();
  expect(hook.result.current.status).toBe('booting');
  expect(order).toEqual(['A boot started']);

  gates[0]?.();
  await settle();
  expect(order).toEqual(['A boot started', 'A boot finished', 'A disposed', 'B boot started']);

  gates[1]?.();
  await settle();
  expect(hook.result.current.status).toBe('ready');
  expect((getBootedNode() as unknown as { id: string }).id).toBe('B');
  expect(order.filter((e) => e === 'B disposed')).toEqual([]);
});
