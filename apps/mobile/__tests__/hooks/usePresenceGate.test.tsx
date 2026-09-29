/**
 * WEB_OWNER_SURFACE_PLAN §3.8 — the presence gate every owner screen shares.
 *
 * `run` settles only once the action is done with (ran, failed, or the sheet
 * was cancelled), so a screen's busy flag held across it covers the sheet and
 * the retry. A passphrase is proven exactly as typed; a PIN is trimmed.
 */

import { act, renderHook } from '@testing-library/react-native';

import { usePresenceGate, type PresenceGateOptions } from '../../src/hooks/usePresenceGate';

const refusal = (): Error => Object.assign(new Error('403'), { errorKey: 'no_user_presence' });

function gate(over: Partial<PresenceGateOptions> = {}) {
  const options: PresenceGateOptions = {
    prove: jest.fn(async () => undefined),
    onError: jest.fn(),
    onSettled: jest.fn(),
    ...over,
  };
  return { options, hook: renderHook(() => usePresenceGate(options)) };
}

/** Has the promise settled yet? */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await act(async () => {
    await Promise.resolve();
  });
  return done;
}

it('a refused action waits on the sheet; run settles only after the retry', async () => {
  const operation = jest.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(undefined);
  const { options, hook } = gate();
  let running!: Promise<void>;
  await act(async () => {
    running = hook.result.current.run(operation);
  });
  expect(hook.result.current.sheet.visible).toBe(true);
  expect(await settled(running)).toBe(false);

  act(() => hook.result.current.sheet.onChangeSecret(' pass phrase '));
  await act(async () => {
    hook.result.current.sheet.onSubmit();
  });
  await act(async () => {
    await running;
  });
  expect(options.prove).toHaveBeenCalledWith(' pass phrase ');
  expect(operation).toHaveBeenCalledTimes(2);
  expect(hook.result.current.sheet.visible).toBe(false);
  expect(options.onError).not.toHaveBeenCalled();
});

it('cancelling the sheet settles run without a retry', async () => {
  const operation = jest.fn().mockRejectedValue(refusal());
  const { options, hook } = gate();
  let running!: Promise<void>;
  await act(async () => {
    running = hook.result.current.run(operation);
  });
  act(() => hook.result.current.sheet.onCancel());
  await act(async () => {
    await running;
  });
  expect(operation).toHaveBeenCalledTimes(1);
  expect(options.prove).not.toHaveBeenCalled();
  expect(hook.result.current.sheet.visible).toBe(false);
});

it('a wrong secret keeps the sheet open and run pending', async () => {
  const operation = jest.fn().mockRejectedValue(refusal());
  const { hook } = gate({
    prove: jest.fn(async () => {
      throw Object.assign(new Error('401'), { errorKey: 'not_proven' });
    }),
  });
  let running!: Promise<void>;
  await act(async () => {
    running = hook.result.current.run(operation);
  });
  act(() => hook.result.current.sheet.onChangeSecret('wrong'));
  await act(async () => {
    hook.result.current.sheet.onSubmit();
  });
  expect(hook.result.current.sheet.error).toBe('That passphrase did not verify.');
  expect(hook.result.current.sheet.visible).toBe(true);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(await settled(running)).toBe(false);
});

it('a staff PIN is trimmed; an empty secret sends nothing and says what is missing', async () => {
  const operation = jest.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(undefined);
  const { options, hook } = gate({ secretKind: 'pin' });
  await act(async () => {
    void hook.result.current.run(operation);
  });
  act(() => hook.result.current.sheet.onChangeSecret('   '));
  await act(async () => {
    hook.result.current.sheet.onSubmit();
  });
  expect(options.prove).not.toHaveBeenCalled();
  // Said on the sheet, not silently ignored: Verify stays pressable.
  expect(hook.result.current.sheet.error).toBe('Enter your PIN.');
  act(() => hook.result.current.sheet.onChangeSecret(' 4821 '));
  await act(async () => {
    hook.result.current.sheet.onSubmit();
  });
  expect(options.prove).toHaveBeenCalledWith('4821');
  expect(operation).toHaveBeenCalledTimes(2);
});

it('any other failure goes to onError and settles run', async () => {
  const boom = Object.assign(new Error('409'), { errorKey: 'tender_closed' });
  const { options, hook } = gate();
  await act(async () => {
    await hook.result.current.run(jest.fn().mockRejectedValue(boom));
  });
  expect(options.onError).toHaveBeenCalledWith(boom);
  expect(hook.result.current.sheet.visible).toBe(false);
  expect(options.onSettled).toHaveBeenCalledTimes(1);
});
