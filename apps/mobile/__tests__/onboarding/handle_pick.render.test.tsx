/**
 * Render tests for the HandlePicker step.
 *
 * Pins the four user-visible states: idle (until first debounce
 * fires), available, taken (with suggestions), and PDS-unreachable
 * (soft-warning, not a hard block).
 *
 * The picker module is exercised end to end through a stubbed
 * global fetch — same pattern as the trust render tests. Debounce is
 * 350ms; tests advance fake timers past it to flush the check.
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { HandlePicker } from '../../src/components/onboarding/handle_pick';

const PDS_HOST = 'test-pds.dinakernel.com';

/**
 * Force the picker to derive the test PDS host. The default code
 * checks `resolveMsgBoxURL()` for "test-mailbox"; we set the env that
 * `msgbox_wiring.ts` reads so it lands on the test fleet.
 */
beforeAll(() => {
  process.env.EXPO_PUBLIC_DINA_MSGBOX_URL = 'wss://test-mailbox.dinakernel.com/ws';
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/**
 * Build a fetch stub that maps full handle strings to a status. Any
 * handle not in the map gets the `defaultStatus` (default 400 =
 * available, matching what real PDS impls return for "Unable to
 * resolve handle").
 */
function stubFetch(
  responses: Record<string, { status: number; did?: string }>,
  defaultStatus = 400,
): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    const handleParam = decodeURIComponent(
      new URL(url).searchParams.get('handle') ?? '',
    );
    const r = responses[handleParam] ?? { status: defaultStatus };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => (r.did !== undefined ? { did: r.did } : {}),
      text: async () => '',
    } as unknown as Response;
  });
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
    fn as unknown as typeof globalThis.fetch;
  return fn;
}

/**
 * Drive timers + microtasks until both debounce + fetch resolution
 * have flushed. Two `act` passes keep React state updates in sync.
 */
async function flushDebounceAndFetch(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(400);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('HandlePicker', () => {
  it('shows ✓ Available when the seed prefix is unbound on the PDS', async () => {
    stubFetch({
      [`raju.${PDS_HOST}`]: { status: 400 }, // available
    });
    const { getByTestId } = render(
      <HandlePicker
        seedPrefix="raju"
        onContinue={() => undefined}
        onBack={() => undefined}
      />,
    );
    await flushDebounceAndFetch();
    expect(getByTestId('handle-status-available')).toBeTruthy();
  });

  it('shows suggestions when the preferred handle is taken', async () => {
    // Preferred + first two candidates are taken; everything else
    // returns 400 (available).
    stubFetch({
      [`raju.${PDS_HOST}`]: { status: 200, did: 'did:plc:abc' },
    });
    const { getByTestId } = render(
      <HandlePicker
        seedPrefix="raju"
        onContinue={() => undefined}
        onBack={() => undefined}
      />,
    );
    await flushDebounceAndFetch();
    expect(getByTestId('handle-status-taken')).toBeTruthy();
    // Suggestions container appears with at least one tappable row.
    const list = getByTestId('handle-suggestions');
    expect(list).toBeTruthy();
  });

  it('selects an alternative when its row is pressed', async () => {
    stubFetch({
      [`raju.${PDS_HOST}`]: { status: 200, did: 'did:plc:abc' },
    });
    const onContinue = jest.fn();
    const { getByTestId } = render(
      <HandlePicker
        seedPrefix="raju"
        onContinue={onContinue}
        onBack={() => undefined}
      />,
    );
    await flushDebounceAndFetch();
    // First suggestion row — find the test ID by querying the list.
    const list = getByTestId('handle-suggestions');
    // The row testIDs include the full handle, e.g.
    // `handle-suggestion-raju42.test-pds.dinakernel.com`. We just
    // grab the first child of the suggestions container.
    const firstRow = (list.children as unknown as { props: { testID?: string } }[])[0];
    expect(firstRow).toBeTruthy();
    const id = firstRow.props.testID ?? '';
    expect(id.startsWith('handle-suggestion-')).toBe(true);
    fireEvent.press(getByTestId(id));
    // After tap, the input should reflect the new prefix and a fresh
    // check should fire — the new handle was stubbed as available
    // (default 400 from `stubFetch`), so we land on the available
    // state.
    await flushDebounceAndFetch();
    expect(getByTestId('handle-status-available')).toBeTruthy();
  });

  it('treats PDS unreachable as a soft-warn (continue allowed)', async () => {
    stubFetch({}, 500); // every handle = HTTP 500
    const { getByTestId } = render(
      <HandlePicker
        seedPrefix="raju"
        onContinue={() => undefined}
        onBack={() => undefined}
      />,
    );
    await flushDebounceAndFetch();
    expect(getByTestId('handle-status-unknown')).toBeTruthy();
  });

  it('marks invalid format synchronously without hitting fetch', async () => {
    const fn = stubFetch({});
    const { getByTestId } = render(
      <HandlePicker
        seedPrefix="ab" // too short — invalid
        onContinue={() => undefined}
        onBack={() => undefined}
      />,
    );
    await flushDebounceAndFetch();
    expect(getByTestId('handle-status-invalid')).toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
  });
});
