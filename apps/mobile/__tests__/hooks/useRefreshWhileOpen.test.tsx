/** A plan screen left open follows the clock and the app's return. */

import { act, render } from '@testing-library/react-native';
import React from 'react';
import { AppState } from 'react-native';

import { useRefreshWhileOpen } from '../../src/hooks/useRefreshWhileOpen';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return { useFocusEffect: (fn: () => () => void) => useEffect(fn, [fn]) };
});

function Screen({ refresh }: { refresh: () => void }): null {
  useRefreshWhileOpen(refresh);
  return null;
}

describe('useRefreshWhileOpen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('refreshes on focus, each minute and on return, and stops when it closes', () => {
    let onChange: (s: string) => void = () => undefined;
    const remove = jest.fn();
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      fn: (s: string) => void,
    ) => {
      onChange = fn;
      return { remove };
    }) as never);
    const refresh = jest.fn();
    const view = render(<Screen refresh={refresh} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    onChange('background');
    expect(refresh).toHaveBeenCalledTimes(2);
    onChange('active');
    expect(refresh).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(remove).toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(120_000));
    expect(refresh).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
